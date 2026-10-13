export function installSkills(
  manifest: {
    digest: string;
    files: Array<{ path: string; body: string; digest: string; executable: boolean }>;
  },
  root?: string,
): Promise<void>;
