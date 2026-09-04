import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { AppProvider } from './context/AppContext';

function renderRoute(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AppProvider>
        <App />
      </AppProvider>
    </MemoryRouter>,
  );
}

describe('platform prototype', () => {
  it('renders the operational dashboard and primary navigation', () => {
    renderRoute('/');
    expect(screen.getByRole('heading', { name: '工作台' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('link', { name: /数据中心/ })).toBeInTheDocument();
    const userMenuTrigger = document.querySelector<HTMLElement>('.sidebar-user-trigger');
    if (!userMenuTrigger) throw new Error('侧边栏用户菜单触发器未渲染');
    expect(userMenuTrigger.querySelector('.user-avatar')).not.toBeInTheDocument();
    expect(userMenuTrigger.querySelector('.sidebar-user-identity')).toBeInTheDocument();
    expect(userMenuTrigger.querySelector('.sidebar-user-chevron')).toBeInTheDocument();
    expect(screen.queryByText('工业质检平台')).not.toBeInTheDocument();
    expect(screen.queryByText('默认工作空间')).not.toBeInTheDocument();
    expect(screen.getByText('训练运行')).toBeInTheDocument();
    expect(screen.getByText('暂无训练任务')).toBeInTheDocument();
  });

  it('lets users choose a task type and advance the training wizard', () => {
    renderRoute('/training/new');
    fireEvent.click(screen.getByRole('button', { name: /语义分割/ }));
    fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
    expect(screen.getByRole('heading', { name: '选择数据与基础模型' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('COCO Segmentation')).toBeInTheDocument();
    expect(screen.getByDisplayValue('SegFormer-B0')).toBeInTheDocument();
    expect(screen.getByDisplayValue('官方预训练权重')).toBeEnabled();
    expect(screen.getAllByText('暂无可训练数据集').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /下一步/ })).toBeDisabled();
  });

  it('does not expose task creation without an administrator session', () => {
    renderRoute('/datasets');
    expect(screen.queryByRole('button', { name: '创建任务' })).not.toBeInTheDocument();
  });

  it('opens the current role guide from the help entry', () => {
    renderRoute('/');
    const helpButton = document.querySelector<HTMLButtonElement>('.utility-nav button');
    if (!helpButton) throw new Error('帮助与文档入口未渲染');
    fireEvent.click(helpButton);
    expect(screen.getByRole('heading', { name: '审核员操作手册' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '领取审核任务' })).toBeInTheDocument();
  });
});
