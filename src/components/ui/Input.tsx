'use client';

import React, { useId } from 'react';
import { cn } from '@/lib/utils';

/** Class strings for places that can't take a component (e.g. third-party inputs). */
export const inputClass = 'input input-sm';
export const selectClass = 'input input-sm select';
export const textareaClass = 'input textarea';

type Size = 'sm' | 'md';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { inputSize?: Size }>(
  function Input({ className, inputSize = 'sm', ...rest }, ref) {
    return <input ref={ref} className={cn('input', inputSize === 'sm' && 'input-sm', className)} {...rest} />;
  }
);

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cn('input textarea', className)} {...rest} />;
  }
);

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement> & { inputSize?: Size }>(
  function Select({ className, inputSize = 'sm', children, ...rest }, ref) {
    return (
      <select ref={ref} className={cn('input select', inputSize === 'sm' && 'input-sm', className)} {...rest}>
        {children}
      </select>
    );
  }
);

/**
 * Label + control + hint/error. The child control gets an id, and the hint
 * and error are wired up through aria-describedby / aria-invalid, so screen
 * readers announce them with the field.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>;
  className?: string;
}) {
  const id = useId();
  const controlId = children.props.id || `${id}-control`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [children.props['aria-describedby'], hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('block', className)}>
      <label htmlFor={controlId} className="field-label">
        {label}
      </label>
      {React.cloneElement(children, {
        id: controlId,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : children.props['aria-invalid'],
      })}
      {hint && !error && (
        <p id={hintId} className="mt-1 text-2xs text-ink-3">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-2xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
