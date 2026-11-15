import { getRuntimePlatformInfo } from "../../../utils/runtimePlatform";

export type ShellCommand = {
  words: string[];
  redirects: Array<{ operator: string; target: string }>;
};

/** Parse simple commands and their composition; unsupported evaluation goes to Auto review. */
export function parseShellCommands(source: string): ShellCommand[] | null {
  const windows = getRuntimePlatformInfo().platform === "windows";
  const tokens: Array<{ value: string; operator: boolean }> = [];
  let word = "";
  let started = false;
  let quote = "";
  const flush = () => {
    if (started) tokens.push({ value: word, operator: false });
    word = "";
    started = false;
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote === "'") {
      if (char === "'") quote = "";
      else word += char;
      continue;
    }
    if (!windows && char === "\\") {
      const next = source[++i];
      if (next === undefined) return null;
      if (next !== "\n") {
        word +=
          quote === '"' && !["$", "`", '"', "\\"].includes(next)
            ? `\\${next}`
            : next;
        started = true;
      }
      continue;
    }
    if (
      (!windows && (char === "$" || char === "`")) ||
      (windows && ["%", "!", "^"].includes(char))
    )
      return null;
    if (quote === '"') {
      if (char === '"') quote = "";
      else word += char;
      continue;
    }
    if ((!windows && char === "'") || char === '"') {
      quote = char;
      started = true;
    } else if (!windows && char === "#" && !started) {
      while (i + 1 < source.length && source[i + 1] !== "\n") i++;
    } else if ("(){}".includes(char)) {
      return null;
    } else if ((windows ? "&|<>\n" : ";&|<>\n").includes(char)) {
      // A numeric word adjoining a redirect is its file descriptor.
      if ((char === ">" || char === "<") && /^\d+$/.test(word)) {
        word = "";
        started = false;
      }
      flush();
      let operator = char;
      if (source[i + 1] === char && "&|<>".includes(char))
        operator += source[++i];
      if ((!windows && operator === "&") || operator === "<<") return null;
      tokens.push({ value: operator, operator: true });
    } else if (/\s/.test(char)) {
      flush();
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return null;
  flush();
  const commands: ShellCommand[] = [];
  let current: ShellCommand = { words: [], redirects: [] };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.operator) current.words.push(token.value);
    else if ([">", ">>", "<"].includes(token.value)) {
      const target = tokens[++i];
      if (!target || target.operator) return null;
      current.redirects.push({ operator: token.value, target: target.value });
    } else {
      if (!current.words.length) {
        if (token.value === "\n") continue;
        return null;
      }
      commands.push(current);
      current = { words: [], redirects: [] };
      if (i === tokens.length - 1 && ![";", "\n"].includes(token.value))
        return null;
    }
  }
  if (current.words.length) commands.push(current);
  return commands.length ? commands : null;
}

export function parseSimpleShellWords(source: string): string[] | null {
  const commands = parseShellCommands(source);
  return commands?.length === 1 && !commands[0].redirects.length
    ? commands[0].words
    : null;
}

function optionAllowed(
  value: string,
  exact: ReadonlySet<string>,
  prefixes: readonly string[] = [],
): boolean {
  return (
    !value.startsWith("-") ||
    exact.has(value) ||
    (/^-[A-Za-z]+$/.test(value) &&
      [...value.slice(1)].every((flag) => exact.has(`-${flag}`))) ||
    prefixes.some((prefix) => value.startsWith(prefix))
  );
}

export function isReadOnlyCommand(command: ShellCommand): boolean {
  if (command.redirects.some(({ operator }) => operator !== "<")) return false;
  const words = command.words;
  if (!words?.length) return false;
  const executable = words[0].replace(/^\/(?:usr\/)?bin\//, "");
  if (/[\\/]/.test(executable)) return false;
  const program = executable.toLowerCase().replace(/\.exe$/, "");
  const args = words.slice(1);
  if (program === "pwd" || program === "echo" || program === "printf") {
    return args.every((arg) => !arg.startsWith("-") || program !== "pwd");
  }
  if (program === "wc") {
    const flags = new Set([
      "-l",
      "-w",
      "-c",
      "-m",
      "-L",
      "--lines",
      "--words",
      "--bytes",
      "--chars",
      "--max-line-length",
    ]);
    return args.every((arg) => optionAllowed(arg, flags));
  }
  if (program === "rg") {
    const flags = new Set([
      "-n",
      "--line-number",
      "-i",
      "--ignore-case",
      "-F",
      "--fixed-strings",
      "-w",
      "--word-regexp",
      "-l",
      "--files-with-matches",
      "-L",
      "--files-without-match",
      "-c",
      "--count",
      "--count-matches",
      "--json",
      "--heading",
      "--no-heading",
      "--hidden",
      "--files",
      "--stats",
      "--version",
      "--help",
      "--no-ignore",
      "--follow",
      "-A",
      "-B",
      "-C",
      "-m",
      "-g",
      "--glob",
      "--type",
      "--type-not",
      "--max-count",
      "--context",
    ]);
    return args.every((arg) =>
      optionAllowed(arg, flags, [
        "--glob=",
        "--type=",
        "--type-not=",
        "--max-count=",
        "--context=",
      ]),
    );
  }
  if (program === "git" && args[0] === "diff") {
    const flags = new Set([
      "--cached",
      "--staged",
      "--stat",
      "--shortstat",
      "--name-only",
      "--name-status",
      "--check",
      "--summary",
      "--no-color",
      "--color",
      "--word-diff",
      "-w",
      "--ignore-all-space",
      "--ignore-space-change",
      "--no-ext-diff",
      "--no-textconv",
    ]);
    return (
      args.includes("--no-ext-diff") &&
      args.includes("--no-textconv") &&
      args
        .slice(1)
        .every((arg) =>
          optionAllowed(arg, flags, ["--color=", "--word-diff=", "--unified="]),
        )
    );
  }
  const commonFlags: Record<string, ReadonlySet<string>> = {
    cat: new Set([
      "-A",
      "-b",
      "-e",
      "-E",
      "-n",
      "-s",
      "-t",
      "-T",
      "-u",
      "-v",
      "--show-all",
      "--number-nonblank",
      "--show-ends",
      "--number",
      "--squeeze-blank",
      "--show-tabs",
      "--show-nonprinting",
    ]),
    head: new Set(["-q", "-v", "-n", "-c", "--quiet", "--verbose"]),
    tail: new Set(["-q", "-v", "-n", "-c", "--quiet", "--verbose"]),
    ls: new Set([
      "-a",
      "-A",
      "-d",
      "-F",
      "-h",
      "-i",
      "-k",
      "-l",
      "-n",
      "-o",
      "-p",
      "-r",
      "-R",
      "-s",
      "-S",
      "-t",
      "-U",
      "-1",
      "--all",
      "--almost-all",
      "--directory",
      "--human-readable",
      "--inode",
      "--recursive",
      "--reverse",
      "--size",
    ]),
    stat: new Set(["-f", "-L", "-t", "--dereference", "--terse"]),
    file: new Set(["-b", "-i", "-L", "--brief", "--mime", "--dereference"]),
    du: new Set([
      "-a",
      "-h",
      "-k",
      "-s",
      "--all",
      "--human-readable",
      "--summarize",
    ]),
    df: new Set(["-h", "-k", "-P", "-T", "--human-readable"]),
  };
  if (program in commonFlags) {
    const prefixes =
      program === "head" || program === "tail"
        ? ["--lines=", "--bytes="]
        : program === "ls"
          ? ["--color=", "--sort=", "--time=", "--format="]
          : program === "stat"
            ? ["--format=", "--printf="]
            : [];
    return args.every((arg) =>
      optionAllowed(arg, commonFlags[program], prefixes),
    );
  }
  if (program === "find") {
    const flags = new Set([
      "-H",
      "-L",
      "-P",
      "-and",
      "-or",
      "-not",
      "-name",
      "-iname",
      "-path",
      "-ipath",
      "-type",
      "-maxdepth",
      "-mindepth",
      "-size",
      "-mtime",
      "-mmin",
      "-newer",
      "-empty",
      "-readable",
      "-writable",
      "-executable",
      "-print",
      "-print0",
      "-printf",
      "-ls",
      "-true",
      "-false",
    ]);
    return args.every(
      (arg) =>
        !arg.startsWith("-") || flags.has(arg) || arg === "!" || arg === "(",
    );
  }
  const platform = getRuntimePlatformInfo().platform;
  return (
    platform === "windows" &&
    ["dir", "type", "findstr", "where"].includes(program)
  );
}
