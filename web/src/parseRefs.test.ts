import {
  canonicalRef,
  expandRefsFromLine,
  normalizeStickerRef,
  parseBatchStickerLines,
  parseRefLines,
  splitInputLines,
} from "./parseRefs";
import { describe, expect, it } from "vitest";

describe("normalizeStickerRef", () => {
  it("accepts colon and space forms", () => {
    expect(normalizeStickerRef("FWC 14")).toBe("FWC:14");
    expect(normalizeStickerRef("RSA 7")).toBe("RSA:7");
    expect(normalizeStickerRef("MEX: 5")).toBe("MEX:5");
    expect(normalizeStickerRef("fwc:00")).toBe("FWC:20");
  });
});

describe("canonicalRef", () => {
  it("maps FWC album 00 to FWC:20", () => {
    expect(canonicalRef("FWC:00")).toBe("FWC:20");
    expect(canonicalRef("fwc:0")).toBe("FWC:20");
  });
  it("normalizes team slots", () => {
    expect(canonicalRef("mex:5")).toBe("MEX:5");
    expect(canonicalRef("ENG 12")).toBe("ENG:12");
  });
});

describe("expandRefsFromLine", () => {
  it("expands comma lists after colon", () => {
    expect(expandRefsFromLine("MEX: 1, 2, 3")).toEqual(["MEX:1", "MEX:2", "MEX:3"]);
    expect(expandRefsFromLine("MEX:1,2,3")).toEqual(["MEX:1", "MEX:2", "MEX:3"]);
  });
  it("expands comma lists with space form", () => {
    expect(expandRefsFromLine("FWC 1, 2")).toEqual(["FWC:1", "FWC:2"]);
  });
});

describe("splitInputLines", () => {
  it("normalizes CRLF and lone CR to LF splits", () => {
    expect(splitInputLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitInputLines("a\rb")).toEqual(["a", "b"]);
    expect(splitInputLines("  x  \n  y  ")).toEqual(["x", "y"]);
  });
});

describe("parseRefLines", () => {
  it("parses Windows line endings", () => {
    expect(parseRefLines("SWE 6\r\nEGY 10")).toEqual(["SWE:6", "EGY:10"]);
  });
  it("parses lines with spaces and commas", () => {
    expect(parseRefLines("FWC 14\nRSA 7")).toEqual(["FWC:14", "RSA:7"]);
    expect(parseRefLines("MEX: 1, 2\nENG 5")).toEqual(["MEX:1", "MEX:2", "ENG:5"]);
  });
});

describe("parseBatchStickerLines", () => {
  it("parses counts", () => {
    expect(parseBatchStickerLines("MEX:1 x2\nFWC:5")).toEqual([
      { ref: "MEX:1", count: 2 },
      { ref: "FWC:5", count: 1 },
    ]);
  });
  it("parses space form and comma expansion", () => {
    expect(parseBatchStickerLines("RSA 7\nMEX: 1, 2 x2")).toEqual([
      { ref: "RSA:7", count: 1 },
      { ref: "MEX:1", count: 2 },
      { ref: "MEX:2", count: 2 },
    ]);
  });
});
