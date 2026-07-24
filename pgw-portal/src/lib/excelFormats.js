// Shared Excel number formats for the cash-drawer closeout exports. Defined once
// so every dollar cell — Summary sheet and per-store sheets, single-date and
// multi-day range — renders identically. Number formats only take effect on
// NUMERIC cells; a value written as a string is treated as text and the format
// is silently ignored, so callers must coerce money values with Number() first.
//
// CURRENCY_FMT sections: positive ; negative ; zero. Zero shows a dash ("-")
// aligned with two digits of padding (??); a positive value shows $1,234.56 and
// a negative shows -$120.75. An empty (null/undefined) cell stays blank.
export const CURRENCY_FMT = '$#,##0.00;-$#,##0.00;"-"??';

// Denomination counts (# of $20 bills, etc.) are integers, never money.
export const QTY_FMT = "#,##0";

// Invoice / check / reference numbers must stay text so leading zeros survive
// and long values don't flip to scientific notation.
export const TEXT_FMT = "@";
