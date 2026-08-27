// Shared Excel number formats for every workbook the portal writes — the
// cash-drawer closeout exports and the Report Builder. Defined once so every
// dollar cell, wherever it appears, renders identically. Number formats only
// take effect on NUMERIC cells; a value written as a string is treated as text
// and the format is silently ignored, so callers must coerce money values with
// Number() first.
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

// Hours (worked, flag) and any other plain two-decimal quantity. Same three
// sections as CURRENCY_FMT so a zero reads as a dash here too — a report full
// of "0.00" cells hides the one row that actually has hours on it.
export const HOURS_FMT = '#,##0.00;-#,##0.00;"-"??';

// Ratios are STORED as fractions (0.263) and displayed by Excel's percent
// format, never pre-multiplied by 100 — writing 26.3 with a percent format
// would render 2630%. Zero shows a dash, matching the money and hours cells.
export const PERCENT_FMT = '0.0%;-0.0%;"-"??';
