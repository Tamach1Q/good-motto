export type Sentiment = 'good' | 'motto';
export type TargetType = 'person' | 'place';

export interface Analysis {
  sentiment: Sentiment;
  target_type: TargetType | 'unknown';
  target_id: string | null;
  target_label: string | null;
}

export interface Person {
  /** APIの人物ID。SlackユーザーIDへの対応付けはサーバーで行います。 */
  id: string;
  name: string;
  /** API契約v1への任意追加項目。未提供でも動作します。 */
  username?: string;
  avatar_url?: string;
  workspace_label?: string;
}

export interface Place { id: string; name: string }
export type Target = { type: 'person'; person: Person } | { type: 'place'; place: Place };
export interface PostInput {
  text: string;
  sentiment: Sentiment;
  target_type: TargetType;
  target_id: string;
}
export interface PostResult { post_id: string; status: 'created' }
export interface SessionUser {
  person_id: string;
  display_name: string;
  terms_accepted: boolean;
  feedback_opt_in: boolean;
}
export interface Preferences { terms_accepted: boolean; feedback_opt_in: boolean }
export interface Api {
  me(signal?: AbortSignal): Promise<SessionUser>;
  preferences(input: Preferences, signal?: AbortSignal): Promise<SessionUser>;
  logout(signal?: AbortSignal): Promise<void>;
  analyze(text: string, signal?: AbortSignal): Promise<Analysis>;
  people(query: string, signal?: AbortSignal): Promise<Person[]>;
  places(signal?: AbortSignal): Promise<Place[]>;
  post(input: PostInput, signal?: AbortSignal): Promise<PostResult>;
}
