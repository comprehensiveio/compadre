export interface ClosableHttpServer {
  close(callback: (error?: Error) => void): unknown;
  closeIdleConnections?(): void;
}

export function closeHttpServer(server: ClosableHttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });
}
