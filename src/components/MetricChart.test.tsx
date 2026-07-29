import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MetricChart } from './MetricChart';

describe('MetricChart', () => {
  it('renders score and loss axes and allows series toggling', () => {
    render(<MetricChart labels={['E1', 'E2']} series={[{ name: 'mIoU', color: '#1778d4', values: [0.25, 0.5], format: 'score' }, { name: 'Loss', color: '#e18c28', values: [1.2, 0.8], axis: 'right' }]} />);
    expect(screen.getByText('100.0%')).toBeInTheDocument();
    expect(screen.getByText('1.200')).toBeInTheDocument();
    const loss = screen.getByRole('button', { name: /Loss/ });
    fireEvent.click(loss);
    expect(loss).toHaveAttribute('aria-pressed', 'false');
  });
});
