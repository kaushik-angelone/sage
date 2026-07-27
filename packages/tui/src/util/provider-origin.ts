const contains = (consoleManagedProviders: string[] | ReadonlySet<string> | undefined | null, providerID: string) => {
  if (!consoleManagedProviders) return false
  return Array.isArray(consoleManagedProviders)
    ? consoleManagedProviders.includes(providerID)
    : consoleManagedProviders.has(providerID)
}

export const isConsoleManagedProvider = (
  consoleManagedProviders: string[] | ReadonlySet<string> | undefined | null,
  providerID: string,
) => contains(consoleManagedProviders, providerID)
