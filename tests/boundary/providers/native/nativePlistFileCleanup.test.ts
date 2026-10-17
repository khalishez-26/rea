import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({
  path: undefined as string | undefined,
  failRead: false,
  failClose: false,
  closes: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (args[0] !== faults.path) return handle;
      const read = handle.read.bind(handle) as typeof handle.read;
      const close = handle.close.bind(handle);
      handle.read = ((...readArgs: Parameters<typeof handle.read>) =>
        faults.failRead
          ? Promise.reject(new Error("injected plist prefix read failure"))
          : read(...readArgs)) as typeof handle.read;
      handle.close = async () => {
        faults.closes++;
        if (faults.failClose)
          throw new Error("injected plist descriptor close failure");
        return close();
      };
      return handle;
    },
  };
});

import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import {
  NativeFixtureRunner,
  nativeMachoTarget,
} from "../../../fixtures/nativeCommands.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

const setup = async (failure: {
  read: boolean;
  close: "admission" | "probe";
}) => {
  const root = await createTestTempDirectory("rea-plist-file-cleanup-");
  const path = join(root, "selected.plist");
  await writeFile(path, "<plist><string>value</string></plist>");
  faults.path = path;
  faults.failRead = false;
  faults.failClose = false;
  faults.closes = 0;
  const client = new NativeMacOSProvider(
    {},
    new (class extends NativeFixtureRunner {
      override async run(tool: string, arguments_: readonly string[]) {
        // Arm the probe faults only after admission released its descriptor.
        if (tool === "file" && failure.close === "probe") {
          faults.failRead = failure.read;
          faults.failClose = true;
        }
        return super.run(tool, arguments_);
      }
    })({ file: "ASCII text\n", plutil: JSON.stringify("value") }),
    "darwin",
  ).createClient(nativeMachoTarget(join(root, "target")));
  if (failure.close === "admission") faults.failClose = true;
  return { client, path };
};

const causeMessages = (error: unknown): string[] => {
  const messages: string[] = [];
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (!(next instanceof Error) || seen.has(next)) continue;
    seen.add(next);
    messages.push(next.message);
    pending.push(next.cause);
    if (next instanceof AggregateError) pending.push(...next.errors);
    for (const value of Object.values(next)) pending.push(value);
  }
  return messages;
};

it.for([
  { name: "prefix read and close both reject", read: true },
  { name: "prefix read succeeds and close rejects", read: false },
])(
  "retains the plist probe descriptor when $name",
  async ({ read }, { onTestFinished }) => {
    const { client, path } = await setup({ read, close: "probe" });
    onTestFinished(async () => {
      faults.failClose = false;
      await client.close();
    });

    const inspected = await client.execute("inspect_plist", { path });
    expect(inspected.ok).toBe(false);
    if (inspected.ok)
      throw new Error("Injected close failure was not returned");
    expect(inspected.error.cleanupIncomplete).toBe(true);
    expect(projectAnalysisError(inspected.error).code).toBe(
      "cleanup_incomplete",
    );
    // The physical read failure stays primary beside the cleanup failure.
    expect(causeMessages(inspected.error)).toEqual(
      read
        ? expect.arrayContaining(["injected plist prefix read failure"])
        : expect.not.arrayContaining(["injected plist prefix read failure"]),
    );
    const attempted = faults.closes;

    // Client close retries the exact retained descriptor and reports it.
    const held = await client.close();
    expect(held.ok).toBe(false);
    expect(faults.closes).toBeGreaterThan(attempted);

    faults.failClose = false;
    faults.failRead = false;
    const released = await client.close();
    expect(released.ok).toBe(true);
    // A confirmed release resolves the original error's cleanup uncertainty.
    expect(inspected.error.cleanupIncomplete).toBe(false);
  },
);

it("retains the admission descriptor when its close rejects", async ({
  onTestFinished,
}) => {
  const { client, path } = await setup({ read: false, close: "admission" });
  onTestFinished(async () => {
    faults.failClose = false;
    await client.close();
  });

  const inspected = await client.execute("inspect_plist", { path });
  expect(inspected.ok).toBe(false);
  if (inspected.ok) throw new Error("Injected close failure was not returned");
  expect(inspected.error.cleanupIncomplete).toBe(true);

  faults.failClose = false;
  const released = await client.close();
  expect(released.ok).toBe(true);
  expect(inspected.error.cleanupIncomplete).toBe(false);
});
