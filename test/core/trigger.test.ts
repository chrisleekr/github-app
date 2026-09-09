import { describe, expect, it } from "bun:test";

import { containsTrigger, stripTriggerPhrase } from "../../src/core/trigger";

describe("containsTrigger", () => {
  it("detects trigger phrase at start of comment", () => {
    expect(containsTrigger("@chrisleekr-bot review this")).toBe(true);
  });

  it("detects trigger phrase in middle of comment", () => {
    expect(containsTrigger("Hey @chrisleekr-bot please review")).toBe(true);
  });

  it("detects trigger phrase at end of comment", () => {
    expect(containsTrigger("Please help @chrisleekr-bot")).toBe(true);
  });

  it("detects trigger phrase followed by punctuation", () => {
    expect(containsTrigger("@chrisleekr-bot, please review")).toBe(true);
    expect(containsTrigger("@chrisleekr-bot. Done")).toBe(true);
    expect(containsTrigger("@chrisleekr-bot!")).toBe(true);
  });

  it("returns false when trigger phrase is absent", () => {
    expect(containsTrigger("no mention here")).toBe(false);
  });

  it("returns false for partial matches", () => {
    expect(containsTrigger("@chrisleekr-bots not exact")).toBe(false);
  });

  it("stays correct across repeated calls (global regex lastIndex)", () => {
    expect(containsTrigger("a @chrisleekr-bot b")).toBe(true);
    expect(containsTrigger("@chrisleekr-bot go")).toBe(true);
    expect(containsTrigger("@chrisleekr-bot go")).toBe(true);
  });

  it("accepts a closing parenthesis as a boundary", () => {
    expect(containsTrigger("(cc @chrisleekr-bot) please look")).toBe(true);
  });

  it("handles empty body", () => {
    expect(containsTrigger("")).toBe(false);
  });
});

describe("stripTriggerPhrase", () => {
  const phrase = "@chrisleekr-bot";

  it("keeps the trailing boundary so surrounding punctuation survives", () => {
    expect(stripTriggerPhrase("Hey @chrisleekr-bot, please review", phrase).trim()).toBe(
      "Hey, please review",
    );
  });

  it("strips a leading mention", () => {
    expect(stripTriggerPhrase("@chrisleekr-bot review this", phrase).trim()).toBe("review this");
  });

  it("strips a trailing mention", () => {
    expect(stripTriggerPhrase("please review @chrisleekr-bot", phrase).trim()).toBe(
      "please review",
    );
  });

  it("strips every occurrence, not just the first", () => {
    expect(stripTriggerPhrase("@chrisleekr-bot ping @chrisleekr-bot again", phrase).trim()).toBe(
      "ping again",
    );
  });

  it("leaves a longer login that merely shares the prefix alone", () => {
    expect(stripTriggerPhrase("@chrisleekr-bot-foo ship", phrase)).toBe("@chrisleekr-bot-foo ship");
  });
});
