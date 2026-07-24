import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Threadmark — dev dashboard',
  description: 'Read-only view of ingestion + retrieval for manual testing',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">
          <div className="nav">
            <a href="/">Documents</a>
            <a href="/search">Search</a>
          </div>
          {children}
        </div>
      </body>
    </html>
  );
}
