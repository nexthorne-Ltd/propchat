import React from 'react';
import { SystemHealthView } from '@/components/admin/SystemHealthView';

export const metadata = {
  title: 'System Health & Diagnostics — Zentry Super Admin',
  description: 'Monitor channels, webhooks, email delivery, and background automation health.',
};

export default function AdminHealthPage() {
  return <SystemHealthView />;
}
