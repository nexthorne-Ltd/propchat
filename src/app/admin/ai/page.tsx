import React from 'react';
import { PlatformAiView } from '@/components/admin/PlatformAiView';

export const metadata = {
  title: 'AI Model & Usage — Zentry Super Admin',
  description: 'Manage platform LLM credentials, provider configuration, plan AI limits, and workspace usage.',
};

export default function AdminAiPage() {
  return <PlatformAiView />;
}
