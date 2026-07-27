import { useState, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max'> & {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** Max decimals shown when the field is idle. Trailing zeros are stripped: 6 instead of 6.00. */
  decimals?: number;
};

function clamp(n: number, min?: number, max?: number): number {
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

function display(value: number, decimals?: number): string {
  if (!Number.isFinite(value)) return '';
  if (decimals === undefined) return String(value);
  return String(Number(value.toFixed(decimals)));
}

export function NumberInput({ value, onChange, min, max, decimals, ...rest }: Props) {
  // While the user is typing we show the raw text, not the committed number. That is
  // what makes an empty field (or a half-typed "1.") a legal intermediate state instead
  // of collapsing to 0 and forcing the user to select-all to replace a value.
  const [draft, setDraft] = useState<string | null>(null);

  function handleChange(raw: string) {
    setDraft(raw);
    if (raw.trim() === '') return; // empty means "still typing", never 0
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) onChange(clamp(parsed, min, max));
  }

  function handleBlur() {
    const typed = draft;
    setDraft(null);
    // Left empty or unparseable: keep the last committed value rather than inventing one.
    if (typed === null || typed.trim() === '') return;
    const parsed = Number(typed);
    if (!Number.isFinite(parsed)) return;
    const clamped = clamp(parsed, min, max);
    if (clamped !== value) onChange(clamped);
  }

  return (
    <input
      {...rest}
      type="number"
      min={min}
      max={max}
      value={draft ?? display(value, decimals)}
      onChange={(e) => handleChange(e.target.value)}
      onBlur={handleBlur}
    />
  );
}
