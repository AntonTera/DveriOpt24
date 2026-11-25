const DATE = "\u0414\u0430\u0442\u0430";
const PHILIPP = "\u0424\u0438\u043b\u0438\u043f\u043f";
const SVETLANA = "\u0421\u0432\u0435\u0442\u043b\u0430\u043d\u0430";
const TATIANA = "\u0422\u0430\u0442\u044c\u044f\u043d\u0430";
export const PHILIPP_ID = 7268314;
const UNASSIGNABLE_IDS = new Set([12043998, 8445565]);

function cellValue(value: unknown): unknown {
  return typeof value === "string" ? value.trim() : value;
}

function shiftMark(value: unknown): boolean | null {
  const mark = cellValue(value);
  if (mark === 1 || mark === "1") return true;
  if (mark === 0 || mark === "0" || mark === "" || mark == null) return false;
  return null;
}

export function selectDutyOwner(
  rows: readonly (readonly unknown[])[],
  day: string,
  secondShiftOwnerId?: number
): { ownerId: number; column: string } | null {
  if (!/^(0[1-9]|[12]\d|3[01])\.(0[1-9]|1[0-2])\.\d{4}$/.test(day) || secondShiftOwnerId === PHILIPP_ID) return null;

  const [header, ...dates] = rows;
  if (!header) return null;
  const labels = header.map(cellValue);
  const secondShiftColumns = [SVETLANA, TATIANA].filter((name) => labels.includes(name));
  if (secondShiftColumns.length !== 1) return null;

  const [secondShiftColumn] = secondShiftColumns;
  const [dateIndex, philippIndex, secondShiftIndex] = [DATE, PHILIPP, secondShiftColumn].map((name) => {
    const index = labels.indexOf(name);
    return index === labels.lastIndexOf(name) ? index : -1;
  });
  if (dateIndex < 0 || philippIndex < 0 || secondShiftIndex < 0) return null;

  const matches = dates.filter((row) => cellValue(row[dateIndex]) === day);
  if (matches.length !== 1) return null;

  const [row] = matches;
  const philippMarked = shiftMark(row[philippIndex]);
  const secondShiftMarked = shiftMark(row[secondShiftIndex]);
  if (philippMarked === null || secondShiftMarked === null || philippMarked === secondShiftMarked) return null;
  if (row.some((value, index) => index !== dateIndex && index !== philippIndex && index !== secondShiftIndex &&
      shiftMark(value) === true)) return null;

  if (philippMarked) return { ownerId: PHILIPP_ID, column: PHILIPP };
  if (secondShiftOwnerId === undefined || !Number.isSafeInteger(secondShiftOwnerId) || secondShiftOwnerId <= 0 ||
      UNASSIGNABLE_IDS.has(secondShiftOwnerId)) return null;
  return { ownerId: secondShiftOwnerId, column: secondShiftColumn };
}
