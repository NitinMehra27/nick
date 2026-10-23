'use client';

import { cloneElement, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent-strong text-white shadow-[0_0_16px_rgb(56_214_245/0.25)] hover:brightness-110 disabled:bg-raised disabled:text-faint disabled:shadow-none',
  secondary: 'bg-raised text-ink border border-line hover:border-faint disabled:text-faint',
  ghost: 'text-muted hover:text-ink hover:bg-raised disabled:text-faint',
  danger: 'bg-bad/15 text-bad border border-bad/40 hover:bg-bad/25 disabled:opacity-50',
};

export function Button({ variant = 'secondary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
    />
  );
}

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad';
const TONES: Record<Tone, string> = {
  neutral: 'border-line text-muted',
  accent: 'border-accent/40 text-accent',
  ok: 'border-ok/40 text-ok',
  warn: 'border-warn/40 text-warn',
  bad: 'border-bad/40 text-bad',
};

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status" aria-label={label} className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-faint border-t-accent" />
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && (
        <Button variant="ghost" onClick={onRetry} className="text-bad">
          Retry
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center">
      <p className="font-medium text-ink">{title}</p>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3 border-b border-line px-4 py-4 md:px-8">
      <div>
        <h1 className="text-lg font-semibold">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

export const inputClass =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none';

/**
 * Labelled form control. The label is associated via htmlFor/id (not by nesting) so a
 * select's current value does not become part of its accessible name.
 */
export function Field({ label, children, hint }: { label: string; children: ReactElement<{ id?: string }>; hint?: string }) {
  const generated = useId();
  const id = children.props.id ?? generated;
  return (
    <div className="block text-sm">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted">
        {label}
      </label>
      {cloneElement(children, { id })}
      {hint && <span className="mt-1 block text-xs text-faint">{hint}</span>}
    </div>
  );
}

/**
 * Accessible confirmation dialog for destructive actions. When requireText is set the
 * user must type it before confirming (used for "clear all memory").
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Delete',
  requireText,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  requireText?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState('');
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setTyped('');
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);
  const blocked = !!requireText && typed.trim() !== requireText;
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      className="m-auto w-[min(92vw,28rem)] rounded-xl border border-line bg-surface p-0 text-ink"
    >
      <div className="p-5">
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="mt-2 text-sm text-muted">{body}</div>
        {requireText && (
          <label className="mt-4 block text-sm">
            <span className="mb-1 block text-xs text-muted">
              Type <strong className="text-ink">{requireText}</strong> to confirm
            </span>
            <input className={inputClass} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          </label>
        )}
        {error && <div className="mt-3"><ErrorNote message={error} /></div>}
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onConfirm} disabled={busy || blocked}>
          {busy ? <Spinner label="Working" /> : null}
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
