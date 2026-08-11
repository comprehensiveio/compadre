import type {
  SandboxHandle,
  SandboxProvider,
} from "@tanstack/ai-sandbox";

function superviseHandle(
  handle: SandboxHandle,
  onSpawn: (pid: number) => void,
): SandboxHandle {
  return {
    ...handle,
    process: {
      ...handle.process,
      exec: (command, options) => handle.process.exec(command, options),
      spawn: async (command, options) => {
        const spawned = await handle.process.spawn(command, options);
        onSpawn(spawned.pid);
        return spawned;
      },
    },
    ...(handle.snapshot
      ? { snapshot: (label?: string) => handle.snapshot!(label) }
      : {}),
    ...(handle.fork
      ? {
          fork: async () => superviseHandle(await handle.fork!(), onSpawn),
        }
      : {}),
    destroy: () => handle.destroy(),
  };
}

/** Decorate a provider without changing its sandbox or process semantics. */
export function superviseSandboxProvider(
  provider: SandboxProvider,
  onSpawn: (pid: number) => void,
): SandboxProvider {
  return {
    name: provider.name,
    capabilities: () => provider.capabilities(),
    create: async (input) =>
      superviseHandle(await provider.create(input), onSpawn),
    resume: async (input) => {
      const handle = await provider.resume(input);
      return handle ? superviseHandle(handle, onSpawn) : null;
    },
    ...(provider.restoreSnapshot
      ? {
          restoreSnapshot: async (input) =>
            superviseHandle(await provider.restoreSnapshot!(input), onSpawn),
        }
      : {}),
    destroy: (input) => provider.destroy(input),
  };
}
