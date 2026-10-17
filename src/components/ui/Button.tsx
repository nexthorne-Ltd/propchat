import React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
};

const SIZE: Record<ButtonSize, string> = {
  xs: 'btn-xs',
  sm: 'btn-sm',
  md: '',
  lg: 'btn-lg',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, disables the button and sets aria-busy. */
  loading?: boolean;
  /** Square button holding only an icon. Pass `aria-label`. */
  iconOnly?: boolean;
}

/**
 * The one button. It renders the `.btn` classes from globals.css, so markup
 * that still writes `className="btn btn-primary"` looks identical; new code
 * should use this component.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, iconOnly, className, children, disabled, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn('btn', VARIANT[variant], SIZE[size], iconOnly && 'btn-icon', className)}
      {...rest}
    >
      {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
});
