import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AuthenticatedUser } from './domain.js';
import { AppError } from './errors.js';

export interface AuthService {
  authenticate(accessToken: string): Promise<AuthenticatedUser>;
}

export class SupabaseAuthService implements AuthService {
  constructor(private readonly client: SupabaseClient) {}

  static create(url: string, publishableKey: string) {
    return new SupabaseAuthService(
      createClient(url, publishableKey, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      }),
    );
  }

  async authenticate(accessToken: string): Promise<AuthenticatedUser> {
    const { data, error } = await this.client.auth.getUser(accessToken);
    if (error || !data.user) {
      throw new AppError('UNAUTHENTICATED', 'A valid Supabase access token is required.');
    }
    return { id: data.user.id };
  }
}

export function bearerToken(header: string | undefined): string {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  const token = match?.[1]?.trim();
  if (!token) throw new AppError('UNAUTHENTICATED', 'A bearer token is required.');
  return token;
}
