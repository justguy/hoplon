import type {
  SemanticSearchMatch,
} from '../contracts/semanticSearch.js';
import type {
  SemanticOverlayDocument,
  SemanticSessionOverlay,
} from './semanticSessionOverlayStore.js';

export function lexicalOverlayMatches(
  overlay: SemanticSessionOverlay,
  query: string,
  topK: number,
): Omit<SemanticSearchMatch, 'source' | 'rankSource' | 'freshness'>[] {
  return scoreOverlayDocuments(overlay, query)
    .slice(0, topK)
    .map(({ doc, score }) => ({
      id: doc.id,
      score,
      metadata: { ...doc.metadata, projectId: overlay.projectId },
    }));
}

export function vectorOverlayMatches(
  overlay: SemanticSessionOverlay,
  queryVector: readonly number[],
  topK: number,
): Omit<SemanticSearchMatch, 'source' | 'rankSource' | 'freshness'>[] {
  if (queryVector.length === 0) return [];
  const scored = overlay.documents
    .filter((doc): doc is SemanticOverlayDocument & { readonly vector: readonly number[] } =>
      doc.vector !== undefined && doc.vector.length === queryVector.length)
    .map((doc) => ({
      doc,
      score: cosine(queryVector, doc.vector),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));
  return scored.slice(0, topK).map(({ doc, score }) => ({
    id: doc.id,
    score,
    metadata: { ...doc.metadata, projectId: overlay.projectId },
  }));
}

function scoreOverlayDocuments(overlay: SemanticSessionOverlay, query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return overlay.documents
    .map((doc) => {
      const text = doc.text.toLowerCase();
      const hits = terms.filter((term) => text.includes(term)).length;
      return { doc, score: terms.length === 0 ? 0 : hits / terms.length };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let a2 = 0;
  let b2 = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    a2 += av * av;
    b2 += bv * bv;
  }
  if (a2 === 0 || b2 === 0) return 0;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(a2) * Math.sqrt(b2))));
}
