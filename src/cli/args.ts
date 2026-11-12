/** Tiny argv parser: positional args plus --flag value / --flag=value / --bool. */
export function parseArgs(argv: string[]): { _: string[]; flags: Record<string, string | true> } {
  const _: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) flags[k] = argv[++i]!;
      else flags[k] = true;
    } else _.push(a);
  }
  return { _, flags };
}
export const die = (msg: string, code = 1): never => {
  process.stderr.write(msg + '\n');
  process.exit(code);
};
export const out = (v: unknown) => process.stdout.write(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2) + '\n');
