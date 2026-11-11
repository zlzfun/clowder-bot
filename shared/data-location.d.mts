export function dataRoot(root: string, env?: NodeJS.ProcessEnv, home?: string): string;
export function nativeDataDir(root: string, env?: NodeJS.ProcessEnv, home?: string): string;
export function productDataFile(root: string, env?: NodeJS.ProcessEnv, home?: string): string;
export function enclosingRepository(dir: string): string | null;
