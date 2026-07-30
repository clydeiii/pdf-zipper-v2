export type TwitterMediaKind = 'photo' | 'video' | 'gif' | 'card-image';

export interface ParsedUser {
  username: string;
  fullname: string | null;
  verified: string | null;
  avatarUrl: string | null;
  avatarFetchUrl: string | null;
  avatarFile?: string | null;
}

export interface ParsedMedia {
  position: number;
  kind: TwitterMediaKind;
  origUrl: string;
  fetchUrl: string | null;
  file?: string | null;
  posterUrl: string | null;
  posterFetchUrl: string | null;
  posterFile?: string | null;
  videoUrl: string | null;
  localVideo?: string | null;
}

export interface ParsedCard {
  url: string | null;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  imageFetchUrl: string | null;
  imageFile?: string | null;
}

export interface ParsedPollOption {
  optionIndex: number;
  label: string;
  valuePercent: number | null;
}

export interface ParsedTweet {
  id: string;
  articleId: string | null;
  username: string;
  user: ParsedUser;
  contentHtml: string | null;
  contentText: string | null;
  publishedAt: string | null;
  replyToId: string | null;
  replyToUsers: string[];
  quotedId: string | null;
  retweetedBy: string | null;
  repliesCount: number | null;
  retweetsCount: number | null;
  likesCount: number | null;
  viewsCount: number | null;
  sourceUrl: string;
  isStub: boolean;
  links: string[];
  media: ParsedMedia[];
  card: ParsedCard | null;
  poll: ParsedPollOption[];
  /** Community Note ("readers added context") shown under the tweet, when present. */
  communityNoteHtml: string | null;
  communityNoteText: string | null;
}

export interface ParsedThreadPage {
  mainTweet: ParsedTweet | null;
  ancestors: ParsedTweet[];
  continuation: ParsedTweet[];
  replies: ParsedTweet[];
  quotedTweets: ParsedTweet[];
  nextCursor: string | null;
}

export interface ParsedArticleMedia {
  position: number;
  origUrl: string;
  fetchUrl: string | null;
  file?: string | null;
}

export interface ParsedArticle {
  id: string;
  announcingTweetId: string | null;
  url: string;
  authorUsername: string | null;
  title: string | null;
  previewText: string | null;
  coverImageUrl: string | null;
  coverImageFetchUrl: string | null;
  coverImageFile?: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  publishedAt: string | null;
  harvestedFrom: 'nitter' | 'x.com';
  links: string[];
  media: ParsedArticleMedia[];
}

export interface ArticleFallbackContent {
  title?: string;
  bodyHtml?: string;
  bodyText?: string;
  authorUsername?: string;
}

export interface HarvestTweetOptions {
  url: string;
  bookmarkedAt?: string | Date;
  pdfPath?: string;
  origin: 'worker' | 'backfill' | 'manual';
}

export interface HarvestArticleOptions extends HarvestTweetOptions {
  fallbackContent?: ArticleFallbackContent;
}

export interface TweetHarvestSummary {
  tweetId: string;
  articleId?: string;
  articleHarvested?: boolean;
  tweetsUpserted: number;
  imagesDownloaded: number;
  pagesFetched: number;
}

export interface ArticleHarvestSummary {
  articleId: string;
  imagesDownloaded: number;
  pagesFetched: number;
  harvestedFrom: 'nitter' | 'x.com';
}

export interface ImageIndexRow {
  url: string;
  file: string | null;
  sha256: string | null;
  bytes: number | null;
  content_type: string | null;
  fetched_at: string;
  error: string | null;
}

export interface ImageStoreResult {
  url: string;
  file: string | null;
  sha256: string | null;
  bytes: number | null;
  contentType: string | null;
  downloaded: boolean;
  error: string | null;
}
