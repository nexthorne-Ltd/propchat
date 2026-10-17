import React from 'react';
import { AuditLogView } from '@/components/admin/AuditLogView';

export const metadata = {
  title: 'Audit Log — Zentry Super Admin',
  description: 'Immutable record of platform super admin actions and events.',
};

export default function AdminAuditPage() {
  return <AuditLogView />;
}
