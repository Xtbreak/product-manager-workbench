/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Spin, Typography } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Full-screen, benign "backend is still starting" view. Shown while the backend
 * process is alive but not yet ready (reason `backend_startup_pending_slow`).
 *
 * This is intentionally NOT an error modal: it carries no report / download /
 * restart buttons and no reinstall / antivirus / missing-resource copy — the
 * backend binary exists and was observed listening, so such guidance would be
 * misleading. The top-level gate unmounts this view as soon as the backend
 * becomes ready (switching to the App) or the process exits (switching to the
 * honest-failure view). System-level quit (window close, tray, Cmd+Q) stays
 * available at the OS/main-process layer, so no in-view exit control is needed.
 */
const BackendStartingView: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div
      className='min-h-screen flex flex-col items-center justify-center gap-16px'
      style={{ background: 'var(--wb-canvas, var(--color-bg-1))' }}
      data-testid='backend-starting-view'
    >
      <svg
        width='56'
        height='56'
        viewBox='0 0 1024 1024'
        aria-hidden='true'
        style={{ filter: 'drop-shadow(0 8px 20px rgba(15, 23, 42, 0.14))' }}
      >
        <defs>
          <linearGradient id='wb-starting-bg' x2='0.85' y2='1'>
            <stop stopColor='#566581' />
            <stop offset='1' stopColor='#2C3549' />
          </linearGradient>
          <linearGradient id='wb-starting-panel' x2='0.3' y2='1'>
            <stop stopColor='#FFFFFF' />
            <stop offset='1' stopColor='#E7EBF2' />
          </linearGradient>
        </defs>
        <rect x='64' y='64' width='896' height='896' rx='212' fill='url(#wb-starting-bg)' />
        <rect x='197' y='251' width='630' height='522' rx='76' fill='url(#wb-starting-panel)' />
        <path d='M246 347h532' stroke='#CDD4E0' strokeWidth='18' strokeLinecap='round' />
        <circle cx='254' cy='299' r='12' fill='#929FB5' />
        <circle cx='294' cy='299' r='12' fill='#B3BDCD' />
        <rect x='243' y='397' width='112' height='322' rx='28' fill='#CFD8E8' />
        <rect x='385' y='397' width='223' height='322' rx='28' fill='#879DBE' />
        <rect x='638' y='397' width='142' height='322' rx='28' fill='#BAC9DE' />
        <path d='M428 451h104m-104 52h136m-136 52h85' stroke='#F4F7FC' strokeWidth='18' strokeLinecap='round' />
      </svg>
      <Spin size={22} />
      <div className='text-center px-24px max-w-480px'>
        <Typography.Title heading={5} className='mb-8px text-t-1'>
          {t('common.backendStartup.pendingSlow.title')}
        </Typography.Title>
        <Typography.Paragraph className='mb-0 text-t-secondary' data-testid='backend-starting-description'>
          {t('common.backendStartup.pendingSlow.description')}
        </Typography.Paragraph>
      </div>
    </div>
  );
};

export default BackendStartingView;
