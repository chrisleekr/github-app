/**
 * Parser contract for /proc/net/tcp + /proc/net/tcp6 (issue #265).
 *
 * The two fixtures are verbatim captures from a real Linux container carrying
 * the #264 signature: CLOSE_WAIT (st=08) sockets pinned on a listener,
 * alongside LISTEN (0A) / ESTABLISHED (01) rows and Docker DNS noise the app
 * does not own. They are ground truth, do not hand-edit them.
 *
 * Three ports carry CLOSE_WAIT in the capture, which is what makes the
 * port filter testable:
 *   8080  (0x1F90) IPv4 loopback, tcp4 only
 *   3000  (0x0BB8) IPv4-mapped, tcp6 only, the exact production shape from #264
 *   7070  (0x1B9E) ::1, tcp6 only
 */
import { describe, expect, it } from "bun:test";

import {
  type CloseWaitSocket,
  collectCloseWaitSockets,
  formatProcNetAddress,
  parseProcNetTcp,
} from "../../src/orchestrator/proc-net-tcp";

const tcp4 = await Bun.file(new URL("./fixtures/proc-net-tcp.txt", import.meta.url)).text();
const tcp6 = await Bun.file(new URL("./fixtures/proc-net-tcp6.txt", import.meta.url)).text();

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

/**
 * Minimal synthetic data row for cases the real capture cannot cover
 * (inode=0, lowercase hex, a duplicate inode across both files). The column
 * count matches the kernel's own format so inode stays at whitespace index 9.
 */
function dataRow(opts: {
  sl: number;
  local: string;
  remote: string;
  st: string;
  rxHex: string;
  inode: string;
}): string {
  return [
    `  ${opts.sl}:`,
    opts.local,
    opts.remote,
    opts.st,
    `00000000:${opts.rxHex}`,
    "00:00000000",
    "00000000",
    "  1000",
    "       0",
    opts.inode,
    "1 0000000000000000 20 4 30 10 -1",
  ].join(" ");
}

function byInode(sockets: CloseWaitSocket[]): CloseWaitSocket[] {
  return [...sockets].sort((a, b) => a.inode.localeCompare(b.inode));
}

function inodesOf(sockets: CloseWaitSocket[]): string[] {
  return byInode(sockets).map((s) => s.inode);
}

describe("parseProcNetTcp", () => {
  it("parses every data row of the real captures and skips the header", () => {
    // The header's `tx_queue` / `rx_queue` are two tokens while a data row's
    // `tx:rx` is one, so a parser that keeps the header emits a garbage row.
    expect(parseProcNetTcp(tcp4)).toHaveLength(20);
    expect(parseProcNetTcp(tcp6)).toHaveLength(20);
  });

  it("keeps columns aligned despite the trailing colon on `sl`", () => {
    // `sl` prints as "%4d:" so "0:" is a single token and must not shift the
    // inode away from index 9.
    const [first] = parseProcNetTcp(tcp4);
    expect(first).toEqual({
      local: "0.0.0.0:8080",
      localPort: 8080,
      remote: "0.0.0.0:0",
      st: "0A",
      rx_queue: 0,
      inode: "31006211",
    });
  });

  it("parses the tcp6 wildcard listener row", () => {
    const [first] = parseProcNetTcp(tcp6);
    expect(first).toEqual({
      local: "[::]:7070",
      localPort: 7070,
      remote: "[::]:0",
      st: "0A",
      rx_queue: 0,
      inode: "31006212",
    });
  });

  it("parses rx_queue out of the single tx:rx token", () => {
    const rows = parseProcNetTcp(tcp4);
    // 22 unread bytes + FIN => 0x17 = 23.
    const withPayload = rows.find((r) => r.inode === "31013141");
    expect(withPayload?.rx_queue).toBe(23);
    // Pure half-close, zero payload, FIN only => 1. This is #264's Recv-Q=1.
    const halfClosed = rows.find((r) => r.inode === "31013143");
    expect(halfClosed?.rx_queue).toBe(1);
  });

  it("returns an empty array for empty, header-only, and malformed input", () => {
    expect(parseProcNetTcp("")).toEqual([]);
    expect(parseProcNetTcp("   \n\n")).toEqual([]);
    expect(parseProcNetTcp(HEADER)).toEqual([]);
    expect(parseProcNetTcp("not a proc file at all")).toEqual([]);
    expect(parseProcNetTcp("  0: 0100007F:1F90 0100007F:A582")).toEqual([]);
  });

  it("skips malformed rows without dropping the well-formed ones around them", () => {
    const text = [
      HEADER,
      "  0: garbage",
      dataRow({
        sl: 1,
        local: "0100007F:1F90",
        remote: "0100007F:A582",
        st: "08",
        rxHex: "00000017",
        inode: "31013141",
      }),
      "  2:",
    ].join("\n");
    expect(parseProcNetTcp(text).map((r) => r.inode)).toEqual(["31013141"]);
  });
});

describe("formatProcNetAddress: IPv4", () => {
  it("byte-reverses the single 32-bit address word", () => {
    expect(formatProcNetAddress("0100007F", "1F90")).toBe("127.0.0.1:8080");
    expect(formatProcNetAddress("0B00007F", "AD45")).toBe("127.0.0.11:44357");
    expect(formatProcNetAddress("CE00000A", "0BB8")).toBe("10.0.0.206:3000");
  });

  it("formats the wildcard address", () => {
    expect(formatProcNetAddress("00000000", "0000")).toBe("0.0.0.0:0");
  });

  it("reads the port big-endian, unlike the address", () => {
    // 0x1F90 = 8080. A byte-swapped read would yield 0x901F = 36895.
    expect(formatProcNetAddress("00000000", "1F90")).toBe("0.0.0.0:8080");
  });
});

describe("formatProcNetAddress: IPv6", () => {
  it("byte-reverses each 32-bit word independently for the IPv4-mapped shape", () => {
    // The trap: `ffff` sits in the capture as the word `FFFF0000`, not
    // `0000FFFF`. Reversing the whole 32-char string yields a wrong address.
    expect(formatProcNetAddress("0000000000000000FFFF0000CE00000A", "0BB8")).toBe(
      "[::ffff:10.0.0.206]:3000",
    );
  });

  it("formats loopback and wildcard", () => {
    expect(formatProcNetAddress("00000000000000000000000001000000", "1B9E")).toBe("[::1]:7070");
    expect(formatProcNetAddress("00000000000000000000000000000000", "0000")).toBe("[::]:0");
  });

  it("reads the port big-endian for mapped addresses too", () => {
    // 0x0BB8 = 3000. A byte-swapped read would yield 0xB80B = 47115.
    expect(formatProcNetAddress("0000000000000000FFFF0000CE00000A", "0BB8")).toContain(":3000");
  });
});

describe("formatProcNetAddress: case handling", () => {
  it("decodes lowercase hex identically to uppercase", () => {
    // The kernel prints addresses uppercase, but nothing in the format
    // guarantees it, so decoding must not depend on case.
    expect(formatProcNetAddress("0100007f", "1f90")).toBe("127.0.0.1:8080");
    expect(formatProcNetAddress("0000000000000000ffff0000ce00000a", "0bb8")).toBe(
      "[::ffff:10.0.0.206]:3000",
    );
  });
});

describe("collectCloseWaitSockets: real capture", () => {
  it("returns the IPv4-mapped CLOSE_WAIT set from tcp6 for port 3000", () => {
    const sockets = collectCloseWaitSockets(tcp4, tcp6, 3000);
    expect(inodesOf(sockets)).toEqual(["31005273", "31005274", "31005275", "31005276", "31005278"]);
    expect(byInode(sockets)[0]).toEqual({
      inode: "31005273",
      local: "[::ffff:10.0.0.206]:3000",
      remote: "[::ffff:10.0.0.206]:59932",
      rx_queue: 27,
    });
    // The pure half-close, zero payload socket.
    expect(byInode(sockets)[4]).toEqual({
      inode: "31005278",
      local: "[::ffff:10.0.0.206]:3000",
      remote: "[::ffff:10.0.0.206]:59968",
      rx_queue: 1,
    });
  });

  it("excludes the ESTABLISHED socket that shares port 3000", () => {
    // inode 31005277 is st=01 on the same listener. Only st=08 counts.
    const sockets = collectCloseWaitSockets(tcp4, tcp6, 3000);
    expect(inodesOf(sockets)).not.toContain("31005277");
  });

  it("returns the IPv4 CLOSE_WAIT set from tcp4 for port 8080", () => {
    const sockets = collectCloseWaitSockets(tcp4, tcp6, 8080);
    expect(inodesOf(sockets)).toEqual(["31013138", "31013139", "31013140", "31013141", "31013143"]);
    expect(byInode(sockets)[0]).toEqual({
      inode: "31013138",
      local: "127.0.0.1:8080",
      remote: "127.0.0.1:42326",
      rx_queue: 23,
    });
  });

  it("returns the ::1 CLOSE_WAIT set from tcp6 for port 7070", () => {
    const sockets = collectCloseWaitSockets(tcp4, tcp6, 7070);
    expect(inodesOf(sockets)).toEqual(["31010018", "31010019", "31010020", "31010021", "31010023"]);
    expect(byInode(sockets)[0]).toEqual({
      inode: "31010018",
      local: "[::1]:7070",
      remote: "[::1]:55530",
      rx_queue: 23,
    });
  });

  it("ignores CLOSE_WAIT sockets on every other local port", () => {
    const port8080 = inodesOf(collectCloseWaitSockets(tcp4, tcp6, 8080));
    const port3000 = inodesOf(collectCloseWaitSockets(tcp4, tcp6, 3000));
    const port7070 = inodesOf(collectCloseWaitSockets(tcp4, tcp6, 7070));
    for (const inode of [...port3000, ...port7070]) {
      expect(port8080).not.toContain(inode);
    }
  });

  it("returns nothing for the Docker DNS listener the app does not own", () => {
    // 127.0.0.11:44357 is noise every container carries.
    expect(collectCloseWaitSockets(tcp4, tcp6, 44357)).toEqual([]);
  });

  it("returns nothing for a port with no sockets at all", () => {
    expect(collectCloseWaitSockets(tcp4, tcp6, 65000)).toEqual([]);
  });

  it("reads both files, so a port present only in tcp6 is still found", () => {
    // Passing an empty tcp4 must not lose the mapped tcp6 sockets, and vice
    // versa: one connection can live in either file.
    expect(collectCloseWaitSockets("", tcp6, 3000)).toHaveLength(5);
    expect(collectCloseWaitSockets(tcp4, "", 8080)).toHaveLength(5);
    expect(collectCloseWaitSockets("", tcp6, 8080)).toEqual([]);
  });
});

describe("collectCloseWaitSockets: defensive cases", () => {
  const closeWait = (sl: number, remoteHexPort: string, inode: string): string =>
    dataRow({
      sl,
      local: "0100007F:1F90",
      remote: `0100007F:${remoteHexPort}`,
      st: "08",
      rxHex: "00000001",
      inode,
    });

  it("drops rows with inode 0", () => {
    // Orphaned / TIME_WAIT rows carry inode 0 and own no fd, so they can never
    // be the socket burning CPU.
    const text = [HEADER, closeWait(0, "A582", "0"), closeWait(1, "A596", "31013143")].join("\n");
    expect(inodesOf(collectCloseWaitSockets(text, "", 8080))).toEqual(["31013143"]);
  });

  it("dedupes by inode when the same socket appears in both files", () => {
    const text = [HEADER, closeWait(0, "A582", "31013141")].join("\n");
    const sockets = collectCloseWaitSockets(text, text, 8080);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.inode).toBe("31013141");
  });

  it("matches the CLOSE_WAIT state and address hex case-insensitively", () => {
    const text = [
      HEADER,
      dataRow({
        sl: 0,
        local: "0100007f:1f90",
        remote: "0100007f:a582",
        st: "08",
        rxHex: "00000017",
        inode: "31013141",
      }),
    ].join("\n");
    expect(collectCloseWaitSockets(text, "", 8080)).toEqual([
      {
        inode: "31013141",
        local: "127.0.0.1:8080",
        remote: "127.0.0.1:42370",
        rx_queue: 23,
      },
    ]);
  });

  it("ignores lowercase LISTEN rows on the watched port", () => {
    // Guards against a case-insensitive match that is too eager: 0a is LISTEN,
    // not CLOSE_WAIT.
    const text = [
      HEADER,
      dataRow({
        sl: 0,
        local: "00000000:1F90",
        remote: "00000000:0000",
        st: "0a",
        rxHex: "00000000",
        inode: "31006211",
      }),
    ].join("\n");
    expect(collectCloseWaitSockets(text, "", 8080)).toEqual([]);
  });

  it("returns an empty array when both files are empty or malformed", () => {
    expect(collectCloseWaitSockets("", "", 8080)).toEqual([]);
    expect(collectCloseWaitSockets("junk", "junk", 8080)).toEqual([]);
  });
});

describe("collectCloseWaitSockets: large table (no positional truncation)", () => {
  // Regression for the MAX_ROWS positional cap: the watched CLOSE_WAIT sockets
  // can sit anywhere in the pod-netns-wide table, exactly past the first N rows
  // during the many-connections storm this watchdog exists to catch. A cap on
  // the first N rows would silently drop them. Build a table with far more than
  // any plausible cap of noise, then the watched row LAST.
  const NOISE_ROWS = 6_000;

  function bigTableWithWatchedRowLast(): string {
    const lines: string[] = [HEADER];
    for (let i = 0; i < NOISE_ROWS; i += 1) {
      // ESTABLISHED (st=01) on port 9999 (0x270F): does not match st=08 + 8080.
      lines.push(
        dataRow({
          sl: i,
          local: "0100007F:270F",
          remote: "0100007F:C000",
          st: "01",
          rxHex: "00000000",
          inode: String(40_000_000 + i),
        }),
      );
    }
    // The one watched row, dead last so any first-N cap would miss it.
    lines.push(
      dataRow({
        sl: NOISE_ROWS,
        local: "0100007F:1F90",
        remote: "0100007F:A582",
        st: "08",
        rxHex: "00000017",
        inode: "31099999",
      }),
    );
    return lines.join("\n");
  }

  it("parses every row of a table far larger than any positional cap", () => {
    expect(parseProcNetTcp(bigTableWithWatchedRowLast())).toHaveLength(NOISE_ROWS + 1);
  });

  it("detects a watched CLOSE_WAIT row sitting past row 5000", () => {
    const sockets = collectCloseWaitSockets(bigTableWithWatchedRowLast(), "", 8080);
    expect(sockets).toEqual([
      {
        inode: "31099999",
        local: "127.0.0.1:8080",
        remote: "127.0.0.1:42370",
        rx_queue: 23,
      },
    ]);
  });
});
