import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "./csv.ts";

describe("toCsv", () => {
  it("quotes only when needed and round-trips through the parser", () => {
    const rows = [
      ["Name", "Score", "Note"],
      ["Ada, L.", 91.5, 'Said "hi"\nthen left'],
      ["Linus", null, ""],
    ];
    const csv = toCsv(rows);
    expect(csv).toBe('Name,Score,Note\r\n"Ada, L.",91.5,"Said ""hi""\nthen left"\r\nLinus,,\r\n');
    expect(parseCsv(csv)).toEqual([
      ["Name", "Score", "Note"],
      ["Ada, L.", "91.5", 'Said "hi"\nthen left'],
      ["Linus", "", ""],
    ]);
  });

  it("defuses text a spreadsheet would run as a formula", () => {
    expect(toCsv([["=HYPERLINK(1)", "+1", "-2", "@x", "ok"]])).toBe("'=HYPERLINK(1),'+1,'-2,'@x,ok\r\n");
    expect(toCsv([[-2]])).toBe("-2\r\n"); // numbers stay numbers
  });
});
