'use client';

import React, { useEffect, useState, use } from 'react';
import { useSearchParams } from 'next/navigation';
import { ThumbsUp, ThumbsDown, CheckCircle2, MessageSquare, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';

interface TicketInfo {
  id: string;
  number: number;
  subject: string;
  status: string;
  csat_rating?: 'good' | 'bad' | null;
  csat_comment?: string | null;
  workspace?: {
    id: string;
    name: string;
    logo_url?: string | null;
    brand_color?: string | null;
  };
}

export default function CsatSurveyPage({ params }: { params: Promise<{ ticketId: string }> }) {
  const resolvedParams = use(params);
  const ticketId = resolvedParams.ticketId;
  const searchParams = useSearchParams();

  const initialRating = searchParams.get('rating') === 'bad' ? 'bad' : searchParams.get('rating') === 'good' ? 'good' : null;
  const token = searchParams.get('token') || '';

  const [ticket, setTicket] = useState<TicketInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [rating, setRating] = useState<'good' | 'bad' | null>(initialRating);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const res = await fetch(`/api/csat/rate?ticket_id=${encodeURIComponent(ticketId)}&token=${encodeURIComponent(token)}`);
        if (!res.ok) {
          setError('This survey link is invalid or the ticket could not be found.');
          return;
        }
        const json = await res.json();
        setTicket(json.ticket);
        if (json.ticket.csat_rating) {
          setRating(json.ticket.csat_rating);
          setComment(json.ticket.csat_comment || '');
        } else if (initialRating) {
          setRating(initialRating);
        }
      } catch (e: unknown) {
        console.error('[CSAT Page Load Error]:', e);
        setError('Could not connect to the survey service. Please check your connection.');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [ticketId, token, initialRating]);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!rating) return;

    try {
      setSubmitting(true);
      const res = await fetch('/api/csat/rate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticket_id: ticketId,
          rating,
          comment: comment.trim(),
          token,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        setError(errJson.error || 'Failed to submit rating. Please try again.');
        return;
      }

      setSubmitted(true);
    } catch (err: unknown) {
      console.error('[CSAT Submit Error]:', err);
      setError('A network error occurred while submitting. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-canvas text-ink flex flex-col items-center justify-center p-4 selection:bg-accent/20">
      <div className="w-full max-w-md">
        {/* Workspace Brand Header */}
        <div className="text-center mb-6">
          {ticket?.workspace?.logo_url ? (
            <img
              src={ticket.workspace.logo_url}
              alt={ticket.workspace.name}
              className="h-10 mx-auto mb-3 object-contain"
            />
          ) : (
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-surface-2 border border-line text-lg font-bold text-accent mb-3 shadow-xs">
              {ticket?.workspace?.name ? ticket.workspace.name.charAt(0).toUpperCase() : 'Z'}
            </div>
          )}
          <h1 className="text-lg font-semibold text-ink">
            {ticket?.workspace?.name || 'Support Feedback'}
          </h1>
          <p className="text-xs text-ink-3 mt-1">Customer Satisfaction Survey</p>
        </div>

        {/* Card */}
        <div className="bg-surface rounded-xl border border-line p-6 shadow-sm">
          {loading ? (
            <div className="space-y-4 py-6 text-center">
              <div className="skeleton h-5 w-48 mx-auto rounded-md" />
              <div className="skeleton h-4 w-64 mx-auto rounded-md" />
              <div className="flex justify-center gap-3 pt-4">
                <div className="skeleton h-14 w-28 rounded-lg" />
                <div className="skeleton h-14 w-28 rounded-lg" />
              </div>
            </div>
          ) : error ? (
            <div className="py-6 text-center">
              <AlertCircle className="w-10 h-10 text-danger mx-auto mb-3" />
              <h2 className="text-md font-semibold text-ink">Unable to Load Survey</h2>
              <p className="text-xs text-ink-2 mt-2 leading-relaxed">{error}</p>
            </div>
          ) : submitted ? (
            <div className="py-6 text-center">
              <CheckCircle2 className="w-12 h-12 text-success mx-auto mb-3 animate-fade" />
              <h2 className="text-md font-semibold text-ink">Thank you for your feedback!</h2>
              <p className="text-xs text-ink-2 mt-2 leading-relaxed">
                Your rating of{' '}
                <span className="font-semibold text-ink">
                  {rating === 'good' ? 'Good (Positive)' : 'Bad (Needs Improvement)'}
                </span>{' '}
                has been recorded for ticket #{ticket?.number}. We appreciate your time helping us improve our support.
              </p>
            </div>
          ) : (
            <div>
              {/* Ticket reference */}
              <div className="p-3 bg-surface-2 rounded-lg border border-line/60 mb-5">
                <div className="text-2xs font-semibold text-ink-3 uppercase tracking-wide">
                  Ticket #{ticket?.number}
                </div>
                <div className="text-xs font-medium text-ink truncate mt-0.5">
                  {ticket?.subject || 'Support request'}
                </div>
              </div>

              <h2 className="text-sm font-semibold text-ink text-center mb-1">
                How was your support experience?
              </h2>
              <p className="text-xs text-ink-3 text-center mb-5">
                Please let us know how we handled your request.
              </p>

              {/* Rating Buttons */}
              <div className="grid grid-cols-2 gap-3 mb-5">
                <button
                  type="button"
                  onClick={() => setRating('good')}
                  className={`flex flex-col items-center justify-center p-4 rounded-xl border text-sm font-medium transition-all ${
                    rating === 'good'
                      ? 'border-success bg-success/10 text-success shadow-xs ring-2 ring-success/20'
                      : 'border-line bg-surface hover:bg-surface-2 text-ink-2 hover:text-ink'
                  }`}
                >
                  <ThumbsUp className={`w-7 h-7 mb-2 ${rating === 'good' ? 'scale-110' : ''} transition-transform`} />
                  <span>Good</span>
                </button>

                <button
                  type="button"
                  onClick={() => setRating('bad')}
                  className={`flex flex-col items-center justify-center p-4 rounded-xl border text-sm font-medium transition-all ${
                    rating === 'bad'
                      ? 'border-danger bg-danger/10 text-danger shadow-xs ring-2 ring-danger/20'
                      : 'border-line bg-surface hover:bg-surface-2 text-ink-2 hover:text-ink'
                  }`}
                >
                  <ThumbsDown className={`w-7 h-7 mb-2 ${rating === 'bad' ? 'scale-110' : ''} transition-transform`} />
                  <span>Bad</span>
                </button>
              </div>

              {/* Optional Comment */}
              <div className="mb-5">
                <label htmlFor="csat-comment" className="block text-xs font-medium text-ink-2 mb-1.5">
                  Optional comment
                </label>
                <div className="relative">
                  <textarea
                    id="csat-comment"
                    rows={3}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="Tell us what went well or what we could improve..."
                    className="w-full text-xs rounded-lg border border-line bg-surface p-3 text-ink placeholder:text-ink-3 focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent resize-none"
                    maxLength={1000}
                  />
                  <div className="absolute right-2.5 bottom-2 text-2xs text-ink-3">
                    {comment.length}/1000
                  </div>
                </div>
              </div>

              {/* Submit Button */}
              <Button
                variant="primary"
                size="md"
                disabled={!rating}
                loading={submitting}
                onClick={handleSubmit}
                className="w-full"
              >
                Submit feedback
              </Button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="text-center mt-6 text-2xs text-ink-3">
          Powered by Zentry Customer Support
        </div>
      </div>
    </main>
  );
}
