/**
 * Pure parser for the kernel's `/proc/net/tcp` + `/proc/net/tcp6` tables
 * (issue #265).
 *
 * Zero fs, zero timers: the caller supplies the file bytes. That keeps the
 * decoding rules, which are fiddly and easy to get subtly wrong, testable
 * against real captures on any OS rather than only on a Linux box.
 *
 * Format notes that drive the implementation below, all verified against a
 * capture from a real Linux container:
 *
 * - Rows are whitespace-tokenized, NEVER sliced at fixed byte offsets: the
 *   tcp4 table right-pads every line to 149 chars but tcp6 does not pad.
 * - `sl` prints as "%4d:" so "7:" is a single token and does not shift the
 *   later columns. Useful indices: local=1, rem=2, st=3, queues=4, inode=9.
 * - `tx_queue` and `rx_queue` are two header words but ONE data token
 *   ("tx:rx"), which is why the header row can never parse as data.
 * - Address hex is uppercase while the trailing columns are lowercase, so
 *   nothing about the format guarantees case. Match case-insensitively.
 */

/** One parsed row of a /proc/net/tcp{,6} table, addresses already decoded. */
export interface ProcNetTcpRow {
  /** Formatted local endpoint, e.g. `127.0.0.1:8080` or `[::ffff:10.0.0.206]:3000`. */
  local: string;
  /** Local port in decimal, split out so callers can filter without re-parsing `local`. */
  localPort: number;
  remote: string;
  /** Raw two-char hex connection state, as printed. `08` is CLOSE_WAIT. */
  st: string;
  /** Bytes the socket has received but the app has not read, plus 1 for a pending FIN. */
  rx_queue: number;
  /** Socket inode. Unique across both tables, unlike `sl`. */
  inode: string;
}

/** A CLOSE_WAIT socket on a watched local port. */
export interface CloseWaitSocket {
  inode: string;
  local: string;
  remote: string;
  rx_queue: number;
}

/** TCP_CLOSE_WAIT in the kernel's state enum. */
const CLOSE_WAIT_STATE = "08";

/**
 * Rows for orphaned sockets carry inode 0. They own no file descriptor, so
 * they cannot be the socket an event loop is spinning on.
 */
const NO_INODE = "0";

const ADDRESS = /^(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{32}):[0-9A-Fa-f]{4}$/;
const STATE = /^[0-9A-Fa-f]{2}$/;
const QUEUES = /^[0-9A-Fa-f]{8}:([0-9A-Fa-f]{8})$/;
const INODE = /^\d+$/;

/** Split a hex string into its bytes, most significant first. */
function hexBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

/** An IPv4 address is one 32-bit word printed little-endian, so reverse its bytes. */
function formatIpv4(hex: string): string {
  return hexBytes(hex).reverse().join(".");
}

/**
 * An IPv6 address is four 32-bit words, each printed little-endian but the
 * words themselves in network order. So each word is byte-reversed
 * INDEPENDENTLY: reversing the whole 32-char string yields a wrong address.
 * `::ffff:10.0.0.206` appears in the table as `0000000000000000FFFF0000CE00000A`,
 * where the `ffff` sits in the word `FFFF0000`, not `0000FFFF`.
 */
function ipv6Bytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let word = 0; word < 4; word += 1) {
    bytes.push(...hexBytes(hex.slice(word * 8, word * 8 + 8)).reverse());
  }
  return bytes;
}

/** True for the ::ffff:0:0/96 range, which RFC 5952 renders in dotted-quad form. */
function isIpv4Mapped(bytes: number[]): boolean {
  return bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
}

/** Compress the longest run of 2+ zero groups into `::`, per RFC 5952. */
function compressIpv6(groups: number[]): string {
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= groups.length; i += 1) {
    if (i < groups.length && groups[i] === 0) {
      if (runStart === -1) runStart = i;
      continue;
    }
    if (runStart !== -1) {
      if (i - runStart > bestLen) {
        bestLen = i - runStart;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }
  const parts = groups.map((g) => g.toString(16));
  if (bestLen < 2) return parts.join(":");
  return `${parts.slice(0, bestStart).join(":")}::${parts.slice(bestStart + bestLen).join(":")}`;
}

function formatIpv6(hex: string): string {
  const bytes = ipv6Bytes(hex);
  if (isIpv4Mapped(bytes)) return `::ffff:${bytes.slice(12).join(".")}`;
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));
  return compressIpv6(groups);
}

/**
 * Decode one `<address>:<port>` pair into a printable endpoint. The address
 * width selects the family: 8 hex chars is IPv4, 32 is IPv6.
 *
 * The port is big-endian and is NOT byte-swapped, unlike the address. That
 * asymmetry is the format's sharpest edge: `1F90` is 8080, not 36895.
 */
export function formatProcNetAddress(hexAddr: string, hexPort: string): string {
  const port = parseInt(hexPort, 16);
  if (hexAddr.length === 8) return `${formatIpv4(hexAddr)}:${port}`;
  return `[${formatIpv6(hexAddr)}]:${port}`;
}

/** Parse one table line into a row, or null if it is a header, blank, or malformed. */
function parseRow(line: string): ProcNetTcpRow | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 10) return null;

  const local = tokens[1] ?? "";
  const remote = tokens[2] ?? "";
  const st = tokens[3] ?? "";
  const inode = tokens[9] ?? "";
  const queues = QUEUES.exec(tokens[4] ?? "");
  if (!ADDRESS.test(local) || !ADDRESS.test(remote)) return null;
  if (!STATE.test(st) || !INODE.test(inode) || queues === null) return null;

  const [localHex = "", localPortHex = ""] = local.split(":");
  const [remoteHex = "", remotePortHex = ""] = remote.split(":");
  return {
    local: formatProcNetAddress(localHex, localPortHex),
    localPort: parseInt(localPortHex, 16),
    remote: formatProcNetAddress(remoteHex, remotePortHex),
    st,
    rx_queue: parseInt(queues[1] ?? "0", 16),
    inode,
  };
}

/**
 * Iterate a table's lines by scanning for `\n` with `indexOf`, slicing one line
 * at a time. Deliberately NOT `text.split("\n")`: the split would materialize a
 * single array of every line up front, unbounded in the pod-netns-wide table.
 * A positional cap on that array is not an option either, since the watched
 * CLOSE_WAIT rows can sit anywhere in the table (the many-connections storm is
 * exactly when they would fall past a cap). This scan visits every line while
 * holding only one line slice at a time.
 */
function* iterateLines(text: string): Generator<string> {
  const len = text.length;
  let start = 0;
  while (start < len) {
    let nl = text.indexOf("\n", start);
    if (nl === -1) nl = len;
    yield text.slice(start, nl);
    start = nl + 1;
  }
}

/**
 * Parse a whole /proc/net/tcp or /proc/net/tcp6 table.
 *
 * Rows that do not match the expected column shapes are skipped rather than
 * thrown on: that covers the header, blank lines, and any future kernel
 * column change. A watchdog that crashes the process it watches is worse than
 * one that reports nothing.
 */
export function parseProcNetTcp(text: string): ProcNetTcpRow[] {
  const rows: ProcNetTcpRow[] = [];
  for (const line of iterateLines(text)) {
    const row = parseRow(line);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/**
 * Collect every CLOSE_WAIT socket whose LOCAL port is `port`, across both
 * tables.
 *
 * Both files are read because one listener's connections can split across
 * them: an IPv4-mapped socket appears only in tcp6, and a real container also
 * carries rows the app does not own (Docker's DNS listener), so the port
 * filter is what makes the result attributable.
 *
 * Keyed by inode, which is unique across both tables, so a socket seen twice
 * counts once. `sl` is a row index, not an identity, and must never be used.
 */
export function collectCloseWaitSockets(
  tcp4: string,
  tcp6: string,
  port: number,
): CloseWaitSocket[] {
  const byInode = new Map<string, CloseWaitSocket>();
  // Scan both tables line by line and retain only matching rows, so the hot
  // path (run every tick) never materializes a full-table rows array. The
  // filter is applied inside the scan, so worst-case retained size is the tiny
  // CLOSE_WAIT-on-our-port set, not the whole netns table.
  for (const text of [tcp4, tcp6]) {
    for (const line of iterateLines(text)) {
      const row = parseRow(line);
      if (row === null) continue;
      if (row.st.toLowerCase() !== CLOSE_WAIT_STATE) continue;
      if (row.localPort !== port) continue;
      if (row.inode === NO_INODE) continue;
      if (byInode.has(row.inode)) continue;
      byInode.set(row.inode, {
        inode: row.inode,
        local: row.local,
        remote: row.remote,
        rx_queue: row.rx_queue,
      });
    }
  }
  return [...byInode.values()];
}
