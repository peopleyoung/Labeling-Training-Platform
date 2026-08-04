import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pagination } from './ui';

describe('Pagination', () => {
  afterEach(cleanup);

  it('supports 10, 20 and 50 rows per page and page navigation', () => {
    const onPageChange = vi.fn();
    const onPageSizeChange = vi.fn();
    render(<Pagination page={2} pageSize={10} totalItems={26} onPageChange={onPageChange} onPageSizeChange={onPageSizeChange} />);

    expect(screen.getByText('11-20 条')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '10 条' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '20 条' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '50 条' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(onPageChange).toHaveBeenCalledWith(3);
    fireEvent.change(screen.getByLabelText('每页显示条数'), { target: { value: '50' } });
    expect(onPageSizeChange).toHaveBeenCalledWith(50);
  });
});
