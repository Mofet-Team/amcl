// Built-in functions and subroutines of CL/HPM [HP27-610 §4.6] and CL/AM [AM27-610 §4.3.7].

export interface Builtin {
  name: string;
  signature: string;
  description: string;
  kind: 'function' | 'subroutine' | 'predicate';
  /** Only in CL/AM; `background` only in background blocks. */
  dialect?: 'AM' | 'background';
}

const F = (name: string, signature: string, description: string, extra: Partial<Builtin> = {}): Builtin => ({
  name,
  signature,
  description,
  kind: 'function',
  ...extra,
});
const S = (name: string, signature: string, description: string, extra: Partial<Builtin> = {}): Builtin =>
  F(name, signature, description, { kind: 'subroutine', ...extra });

export const BUILTINS: Builtin[] = [
  F('ABS', 'Abs(x)', 'Absolute value.'),
  F('ATAN', 'Atan(x)', 'Arc tangent, in radians.'),
  F('COS', 'Cos(x)', 'Cosine of an angle in radians.'),
  F('EXP', 'Exp(x)', 'e to the power x.'),
  F('INT', 'Int(x)', 'Integer part, truncated toward zero.'),
  F('LN', 'Ln(x)', 'Natural logarithm.'),
  F('LOG10', 'Log10(x)', 'Base-10 logarithm.'),
  F('ROUND', 'Round(x)', 'Nearest integer. NaN outside -32767.4 to 32766.5.'),
  F('SIN', 'Sin(x)', 'Sine of an angle in radians.'),
  F('SQRT', 'Sqrt(x)', 'Square root. Bad for a negative argument.'),
  F('TAN', 'Tan(x)', 'Tangent of an angle in radians.'),
  F('AVG', 'Avg(x, y, ...)', 'Average of up to 16 values.'),
  F('MAX', 'Max(x, y, ...)', 'Largest of up to 16 values.'),
  F('MIN', 'Min(x, y, ...)', 'Smallest of up to 16 values.'),
  F('SUM', 'Sum(x, y, ...)', 'Sum of up to 16 values.'),
  F('DATE_TIME', 'Date_Time', 'Absolute time: seconds since 1979-01-01 00:00. Wait for a moment with WAIT Date_Time > t.'),
  F('NOW', 'Now', 'Time of day: seconds since midnight. WAIT Now > 8 HOURS waits until 08:00.'),
  F('NUMBER', 'Number(t)', 'A Time value in seconds, as a Number.'),
  F('LEN', 'Len(s)', 'Length of a string, without trailing blanks.'),
  F('EQUAL_STRING', 'Equal_String(a, b)', 'Case-insensitive string comparison.'),
  F('BADVAL', 'Badval(x)', 'ON when x is bad (NaN). Conditions only: cannot be stored or sent.', { kind: 'predicate' }),
  F('FINITE', 'Finite(x)', 'ON when x is neither bad nor infinite. Conditions only.', { kind: 'predicate' }),
  S('SET_BAD', 'CALL Set_Bad(x)', 'Store a bad value (NaN) in x. Fails with 111 if x cannot be bad.'),
  S('MODIFY_STRING', 'CALL Modify_String(status, target, target_pos, count, source, source_pos)', 'Copy count characters from source at source_pos into target at target_pos.'),
  S('NUMBER_TO_STRING', 'CALL Number_To_String(status, string, x, "format")', 'Format a number. The format is an upper-case string literal such as "G99999".'),
  F('ORD', 'Ord(state)', 'Zero-based index of an enumeration state.', { dialect: 'AM' }),
  F('SELF', 'Self', 'Slot number of the running block.', { dialect: 'AM' }),
  F('EXISTS', 'Exists(point.param)', 'ON when the parameter exists.', { dialect: 'AM' }),
  F('COMM_ERROR', 'Comm_Error(point.param)', 'ON when fetching the parameter failed. Check it before using non-numeric remote values.', { dialect: 'AM' }),
  F('EQUAL_POINT_ID', 'Equal_Point_ID(p1, p2)', 'ON when two point IDs are the same point.', { dialect: 'AM' }),
  F('EQUAL_NULL_POINT_ID', 'Equal_Null_Point_ID(p)', 'ON when a point ID is null.', { dialect: 'AM' }),
  F('BKG_SWITCHOVER_RESTART', 'BKG_Switchover_Restart', 'ON on the first run after an AM failover.', { dialect: 'background' }),
  S('ALLOW_BAD', 'CALL Allow_Bad(x, y)', 'Store y in x even when y is bad.', { dialect: 'AM' }),
  S('MOVE_PARAMETER', 'CALL Move_Parameter(destination, source, status)', 'Copy a value, array or point ID without aborting on errors. status is a CLERRSTS.', { dialect: 'AM' }),
  S('ENUM_VALUE_STORE', 'CALL Enum_Value_Store(e, ordinal, status)', 'Store an enumeration state by its index.', { dialect: 'AM' }),
  S('SET_NULL_POINT_ID', 'CALL Set_Null_Point_ID(p, status)', 'Set a point ID parameter to the null point.', { dialect: 'AM' }),
  S('GET_CL_SLOT', 'CALL Get_CL_Slot("NAME", slot)', 'Slot number of a block by its upper-case name.', { dialect: 'AM' }),
  S('BKG_DELAY', 'CALL BKG_Delay(t)', 'Pause a background block for up to 1 hour.', { dialect: 'background' }),
  S('BKG_CHANGE_PRIORITY', 'CALL BKG_Change_Priority(LOW | MEDIUM | HIGH)', 'Change the priority of a background block.', { dialect: 'background' }),
];

export function builtin(name: string): Builtin | undefined {
  const upper = name.toUpperCase();
  return BUILTINS.find((b) => b.name === upper);
}
