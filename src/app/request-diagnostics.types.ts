export interface RequestDiagnosticExchange {
  request: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    body?: string;
    mode?: 'no-cors';
    note?: string;
  };
  response?: {
    status: number;
    statusText?: string;
    url?: string | null;
    headers: Record<string, string>;
    body: unknown;
    type?: string;
  };
  failure?: string;
}
