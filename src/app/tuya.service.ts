import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';

import type { TuyaLink } from './link.repository';
import { NativeNfcLaunchService } from './native-nfc-launch.service';
import { TUYA_REGIONS } from './tuya.types';

interface TuyaEnvelope {
  success: boolean;
  result?: unknown;
  code?: string | number;
}

interface HttpResult {
  status: number;
  body: unknown;
}

export class TuyaRequestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TuyaRequestError';
  }
}

@Injectable({ providedIn: 'root' })
export class TuyaService {
  private readonly http = inject(HttpClient);
  private readonly nativeHttp = inject(NativeNfcLaunchService);

  async execute(link: TuyaLink, timeoutMs: number): Promise<void> {
    const config = link.tuya;
    const baseUrl = TUYA_REGIONS[config.region].baseUrl;
    const tokenPath = '/v1.0/token?grant_type=1';
    const tokenHeaders = await this.createHeaders(config.clientId, config.clientSecret, 'GET', tokenPath, '');
    const tokenResponse = await this.request(`${baseUrl}${tokenPath}`, 'GET', tokenHeaders, undefined, timeoutMs);

    if (tokenResponse.status < 200 || tokenResponse.status >= 300) {
      throw new TuyaRequestError(`Autenticazione Tuya non riuscita: HTTP ${tokenResponse.status}.`);
    }
    if (!isTuyaEnvelope(tokenResponse.body) || !tokenResponse.body.success) {
      throw new TuyaRequestError('Autenticazione Tuya non riuscita.');
    }

    const tokenResult = tokenResponse.body.result;
    if (
      !isRecord(tokenResult) ||
      typeof tokenResult['access_token'] !== 'string' ||
      !tokenResult['access_token'].trim()
    ) {
      throw new TuyaRequestError('La risposta di autenticazione Tuya non è valida.');
    }

    const commandPath = `/v1.0/iot-03/devices/${encodeURIComponent(config.deviceId)}/commands`;
    const commandHeaders = await this.createHeaders(
      config.clientId,
      config.clientSecret,
      'POST',
      commandPath,
      config.body,
      tokenResult['access_token'],
    );
    const commandResponse = await this.request(
      `${baseUrl}${commandPath}`,
      'POST',
      commandHeaders,
      config.body,
      timeoutMs,
    );

    if (commandResponse.status < 200 || commandResponse.status >= 300) {
      throw new TuyaRequestError(`La chiamata Tuya non è riuscita: HTTP ${commandResponse.status}.`);
    }
    if (!isTuyaEnvelope(commandResponse.body)) {
      throw new TuyaRequestError('La risposta del servizio Tuya non è valida.');
    }
    if (!commandResponse.body.success) {
      throw new TuyaRequestError('Tuya ha rifiutato il comando.');
    }
  }

  private async createHeaders(
    clientId: string,
    clientSecret: string,
    method: 'GET' | 'POST',
    path: string,
    body: string,
    accessToken?: string,
  ): Promise<Record<string, string>> {
    if (!globalThis.crypto?.subtle) {
      throw new TuyaRequestError('Questo dispositivo non supporta la firma crittografica richiesta da Tuya.');
    }
    const timestamp = Date.now().toString();
    const bodyHash = await sha256Hex(body);
    const stringToSign = `${method}\n${bodyHash}\n\n${path}`;
    const sign = await hmacSha256Hex(clientSecret, `${clientId}${accessToken ?? ''}${timestamp}${stringToSign}`);

    return {
      client_id: clientId,
      sign,
      t: timestamp,
      sign_method: 'HMAC-SHA256',
      ...(accessToken ? { access_token: accessToken } : {}),
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  private async request(
    url: string,
    method: 'GET' | 'POST',
    headers: Record<string, string>,
    body: string | undefined,
    timeoutMs: number,
  ): Promise<HttpResult> {
    try {
      if (this.nativeHttp.isAndroidApp) {
        const response = await this.nativeHttp.httpRequest(url, method, headers, body, timeoutMs);
        return { status: response.status, body: response.data };
      }

      const response = await firstValueFrom(
        this.http
          .request<unknown>(method, url, {
            headers,
            body,
            observe: 'response',
          })
          .pipe(timeout({ first: timeoutMs })),
      );
      return { status: response.status, body: response.body };
    } catch (error) {
      if (error instanceof TuyaRequestError) throw error;
      if (error instanceof TimeoutError) {
        throw new TuyaRequestError(`Timeout dopo ${Math.ceil(timeoutMs / 1000)} secondi: nessuna risposta Tuya.`);
      }
      if (error instanceof HttpErrorResponse) {
        if (error.status === 0) {
          throw new TuyaRequestError(
            this.nativeHttp.isAndroidApp
              ? 'Richiesta Tuya non raggiungibile: verifica rete e configurazione Android.'
              : 'Richiesta Tuya bloccata o non raggiungibile: verifica rete e CORS.',
          );
        }
        throw new TuyaRequestError(`Chiamata Tuya non riuscita: HTTP ${error.status}.`);
      }
      throw new TuyaRequestError(
        this.nativeHttp.isAndroidApp
          ? 'Richiesta Tuya non riuscita: verifica rete e configurazione Android.'
          : 'Richiesta Tuya non riuscita: verifica rete e CORS.',
        { cause: error },
      );
    }
  }
}

function isTuyaEnvelope(value: unknown): value is TuyaEnvelope {
  return isRecord(value) && typeof value['success'] === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toHex(digest);
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return toHex(signature).toUpperCase();
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
