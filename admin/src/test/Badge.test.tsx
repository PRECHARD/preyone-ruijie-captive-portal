import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import Badge from '../components/Badge';

describe('Badge', () => {
  it('renders children text', () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('applies default variant when none specified', () => {
    render(<Badge>Default</Badge>);
    const el = screen.getByText('Default');
    expect(el).toBeInTheDocument();
  });

  it('renders with active variant', () => {
    render(<Badge variant="active">Online</Badge>);
    expect(screen.getByText('Online')).toBeInTheDocument();
  });

  it('renders with info variant', () => {
    render(<Badge variant="info">Manager</Badge>);
    expect(screen.getByText('Manager')).toBeInTheDocument();
  });
});
