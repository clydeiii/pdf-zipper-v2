/**
 * DeCruft URL cleaner — shared logic loaded by content.js, background.js, popup.js.
 *
 * Strips tracking/campaign cruft from URLs so links open in their canonical form.
 * Three rule layers:
 *   GLOBAL     — params that are tracking-only on every site (utm_*, fbclid, ...)
 *   SITE       — per-host extras only safe to strip on that host (host-keyed)
 *   SIGNATURE  — host-independent: if a URL carries a distinctive "marker" param,
 *                strip the whole set on ANY domain. Catches platform cruft on
 *                custom domains (e.g. Substack publications on platformer.news)
 *                and lets generic short params (`r`) be stripped only when a
 *                marker is also present, so they're safe on unrelated sites.
 *
 * Adding a new example later = add the param to GLOBAL_EXACT (if universal), to
 * SITE_RULES (if host-specific), or to SIGNATURE_RULES (if it's a platform that
 * rides on custom domains). Nothing else to touch.
 */
(function (root) {
  'use strict';

  // Param NAME prefixes that are always tracking. Matched case-insensitively.
  // (utm_ covers utm_source/medium/campaign/term/content/id/source_platform/
  //  creative_format/marketing_tactic; pk_/mtm_/matomo_/piwik_ = Matomo/Piwik.)
  const GLOBAL_PREFIXES = ['utm_', 'utm-', 'hsa_', 'pk_', 'mtm_', 'matomo_', 'piwik_'];

  // Exact param names that are tracking-only on every site.
  const GLOBAL_EXACT = new Set([
    // --- Ad-click IDs ---
    'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'gad_source',
    'gad', 'srsltid', 'msclkid', 'twclid', 'ttclid', 'yclid', 'ymclid',
    'ysclid', 'li_fat_id', 'rdt_cid', 'epik', 'vmcid', 'mibextid',
    'fbadid', 'fb_action_ids', 'fb_action_types', 'fb_source', 'fb_ref',
    // --- Google Analytics cross-domain ---
    '_ga', '_gl', '_openstat',
    // --- Email / marketing platforms ---
    'mc_cid', 'mc_eid', 'mkt_tok', 'mkwid', 'mkevt', 'mkcid',
    '_hsenc', '_hsmi', '__hssc', '__hstc', '__hsfp', 'hsctatracking',
    '_bta_tid', '_bta_c', 'vero_id', 'vero_conv', 'oly_anon_id', 'oly_enc_id',
    'ml_subscriber', 'ml_subscriber_hash', '_ke', '_kx', 'sc_campaign',
    'sc_channel', 'sc_content', 'sc_medium', 'sc_outcome', 'sc_geo', 'sc_country',
    'elqtrack', 'elqtrackid', 'elq', 'elqcampaignid', 'elqaid', 'elqat',
    // --- Branch / attribution / misc analytics ---
    '_branch_match_id', '_branch_referrer', 'spm', 'scm', 'wt_mc', 'wt_zmc',
    'wt.mc_id', 'otc', 'oicd', 'guccounter', 'guce_referrer',
    'guce_referrer_sig', 'ncid', 'cmpid', 'campaign_id', 's_cid', 'ueid',
    'wickedid', 'rb_clickid', 'obclickid', 'soc_src', 'soc_trk', 'sr_share',
    'igshid', 'igsh', 'wbclid', 'campid', 'cuid', 'icid',
  ]);

  // Per-host extras. Key = host suffix (matches host === key OR host endsWith '.'+key).
  // These params are only safe to strip on the named host (elsewhere they may carry
  // real meaning), so they live here instead of in the global lists.
  const SITE_RULES = {
    'substack.com': ['r', 'comments'],
    'beehiiv.com': ['_bhlid'],
    'youtube.com': ['si', 'feature', 'kw', 'pp'],
    'youtu.be': ['si', 'feature'],
    'x.com': ['s', 't', 'ref_src', 'ref_url'],
    'twitter.com': ['s', 't', 'ref_src', 'ref_url'],
    'reddit.com': ['share_id', 'correlation_id', 'ref', 'ref_source', 'rdt',
      '$deep_link', '$original_url'],
    'facebook.com': ['comment_tracking', 'notif_t', 'notif_id', 'ref', 'refid',
      'refsrc', 'rc', 'hc_location'],
    'linkedin.com': ['trk', 'trkinfo', 'refid', 'midtoken', 'lipi', 'origintracker'],
    'spotify.com': ['si', 'nd', 'context'],
    'google.com': ['ved', 'ei', 'sca_esv', 'sxsrf', 'usg', 'gs_lcp', 'gs_lp',
      'sourceid', 'sclient', 'biw', 'bih', 'dpr'],
    'instagram.com': ['img_index', 'hl'],
    'tiktok.com': ['is_from_webapp', 'sender_device', 'web_id', '_r', '_t'],
    'ebay.com': ['_trkparms', '_trksid', 'hash', 'amdata', 'epid'],
    'amazon.com': ['ref', 'pd_rd_r', 'pd_rd_w', 'pd_rd_wg', 'pf_rd_p',
      'pf_rd_r', 'pf_rd_s', 'pf_rd_t', 'pf_rd_i', 'pf_rd_m', '_encoding',
      'psc', 'qid', 'sr', 'th', 'dib', 'dib_tag', 'content-id', 'crid', 'sprefix'],
  };

  // Signature rules: host-independent. If a URL carries ANY "marker" param, the
  // whole "strip" set is removed — on any domain. This catches platform cruft
  // that rides on custom domains (e.g. Substack publications on their own domain
  // like platformer.news, which still emit publication_id/post_id/r/...), and it
  // lets us strip otherwise-generic short params (like `r`) ONLY when they appear
  // alongside a distinctive marker, so they're never touched on unrelated sites.
  const SIGNATURE_RULES = [
    {
      name: 'substack',
      markers: ['publication_id', 'post_id', 'isfreemail', 'triedredirect',
        'showwelcomeonshare'],
      strip: ['publication_id', 'post_id', 'isfreemail', 'triedredirect',
        'showwelcomeonshare', 'r'],
    },
  ];

  function hostMatches(host, key) {
    return host === key || host.endsWith('.' + key);
  }

  // Names to strip purely because a signature rule's marker was present in the URL.
  function signatureParamsFor(presentLowerNames) {
    const out = new Set();
    for (const rule of SIGNATURE_RULES) {
      if (rule.markers.some((m) => presentLowerNames.has(m))) {
        rule.strip.forEach((s) => out.add(s));
      }
    }
    return out;
  }

  function siteParamsFor(host) {
    const out = new Set();
    for (const key in SITE_RULES) {
      if (hostMatches(host, key)) SITE_RULES[key].forEach((p) => out.add(p.toLowerCase()));
    }
    return out;
  }

  function shouldStrip(name, host, sitParams) {
    const lower = name.toLowerCase();
    if (GLOBAL_PREFIXES.some((p) => lower.startsWith(p))) return true;
    if (GLOBAL_EXACT.has(lower)) return true;
    if (sitParams.has(lower)) return true;
    return false;
  }

  /**
   * Returns a cleaned URL string, or the original if nothing changed / unparseable.
   * `base` lets callers resolve relative hrefs (pass document URL).
   */
  function cleanUrl(raw, base) {
    let u;
    try {
      u = base ? new URL(raw, base) : new URL(raw);
    } catch (e) {
      return raw;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;
    if (!u.search) return raw; // fast path: no query string, nothing to strip

    const host = u.hostname.toLowerCase();
    const siteParams = siteParamsFor(host);
    const present = new Set([...u.searchParams.keys()].map((k) => k.toLowerCase()));
    const sigParams = signatureParamsFor(present);

    // Rebuild the query, dropping cruft and preserving order of survivors.
    const kept = [];
    for (const [name, value] of u.searchParams.entries()) {
      const drop = shouldStrip(name, host, siteParams) || sigParams.has(name.toLowerCase());
      if (!drop) kept.push([name, value]);
    }

    const newParams = new URLSearchParams();
    for (const [name, value] of kept) newParams.append(name, value);
    const newSearch = newParams.toString();
    u.search = newSearch ? '?' + newSearch : '';

    const out = u.toString();
    return out === raw ? raw : out;
  }

  root.DeCruft = { cleanUrl, GLOBAL_PREFIXES, GLOBAL_EXACT, SITE_RULES, SIGNATURE_RULES };
})(typeof self !== 'undefined' ? self : this);
