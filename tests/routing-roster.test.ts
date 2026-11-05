import { describe, expect, it } from "vitest";
import { selectDutyOwner } from "@/lib/routing/roster";

const dateColumn = "\u0414\u0430\u0442\u0430";
const philipp = "\u0424\u0438\u043b\u0438\u043f\u043f";
const svetlana = "\u0421\u0432\u0435\u0442\u043b\u0430\u043d\u0430";
const header = [dateColumn, philipp, svetlana] as const;
const day = "05.11.2026";
const svetlanaId = 12345678;

describe("selectDutyOwner", () => {
  it("selects Philipp from the unique caller-provided Moscow date without a Svetlana mapping", () => {
    expect(selectDutyOwner([header, ["04.11.2026", 0, 1], [day, 1], ["06.11.2026", 0, 1]], day))
      .toEqual({ ownerId: 7268314, column: philipp });
  });

  it("matches reordered Russian headers and accepts a string mark for mapped Svetlana", () => {
    expect(selectDutyOwner([[svetlana, ` ${dateColumn} `, philipp], ["1", day, "0"]], day, svetlanaId))
      .toEqual({ ownerId: svetlanaId, column: svetlana });
  });

  it("fails closed when the date is absent, malformed, or duplicated", () => {
    expect(selectDutyOwner([header, ["04.11.2026", 1, 0]], day)).toBeNull();
    expect(selectDutyOwner([header, ["2026-11-05", 1, 0]], "2026-11-05")).toBeNull();
    expect(selectDutyOwner([header, [day, 1, 0], [day]], day)).toBeNull();
  });

  it("requires unique expected column names", () => {
    expect(selectDutyOwner([], day)).toBeNull();
    expect(selectDutyOwner([[dateColumn, philipp], [day, 1]], day)).toBeNull();
    expect(selectDutyOwner([["date", philipp, svetlana], [day, 1, 0]], day)).toBeNull();
    expect(selectDutyOwner([[dateColumn, philipp, svetlana, philipp], [day, 1, 0, 0]], day)).toBeNull();
  });

  it.each([[0, ""], [1, "1"], [1, "off"], [1, 2], [true, 0], ["01", 0], [null, undefined]])(
    "rejects missing, ambiguous or invalid marks (%j, %j)",
    (first, second) => {
      expect(selectDutyOwner([header, [day, first, second]], day, svetlanaId)).toBeNull();
    }
  );

  it("rejects an unknown marked column, including when a known column is also marked", () => {
    expect(selectDutyOwner([[...header, "Other"], [day, 1, 0, "1"]], day)).toBeNull();
    expect(selectDutyOwner([[...header, "Other"], [day, 0, 0, "1"]], day)).toBeNull();
  });

  it.each([undefined, 12043998, 8445565, 7268314, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "never assigns Svetlana to missing, protected or invalid ID %s",
    (id) => {
      expect(selectDutyOwner([header, [day, 0, 1]], day, id)).toBeNull();
    }
  );

  it("does not select either column when both map to the same owner ID", () => {
    expect(selectDutyOwner([header, [day, 1, 0]], day, 7268314)).toBeNull();
  });
});
