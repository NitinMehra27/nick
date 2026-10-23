import type { Metadata, Viewport } from 'next';
import { AppShell } from '@/components/AppShell';
import './globals.css';

export const metadata: Metadata = {
  title: 'NICK — Natural-language Intelligence for Contextual Knowledge',
  description: 'It understands your goals. It remembers your context. It gets things done.',
};

export const viewport: Viewport = {
  themeColor: '#04070c',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
