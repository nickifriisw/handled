import Anthropic from '@anthropic-ai/sdk';

const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  throw new Error('Missing ANTHROPIC_API_KEY env var');
}

const anthropic = new Anthropic({ apiKey });

/**
 * Personalise an SMS template using Claude Haiku.
 *
 * Variables like {{customer_name}}, {{business_name}}, {{amount}} are replaced
 * before sending to the model, so the LLM only does light natural-language
 * smoothing — it never invents facts.
 *
 * Falls back to the substituted template string on any API error,
 * so message delivery is never blocked by an AI failure.
 */
export async function personalizeMessage(params: {
  template: string;
  variables: Record<string, string>;
  maxTokens?: number;
}): Promise<string> {
  const { template, variables, maxTokens = 160 } = params;

  // Substitute known variables first
  let substituted = template;
  for (const [key, value] of Object.entries(variables)) {
    substituted = substituted.replaceAll(`{{${key}}}`, value);
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system:
        'You are writing short SMS messages for a UK trade business. ' +
        'Make the message sound natural and warm, but keep it concise. ' +
        'Do NOT change any facts, names, times, or amounts. ' +
        'Output only the final SMS text — no quotes, no explanation.',
      messages: [
        {
          role: 'user',
          content: `Lightly rewrite this SMS to sound natural:\n\n${substituted}`,
        },
      ],
    });

    const block = response.content[0];
    if (block.type === 'text') {
      return block.text.trim();
    }
    return substituted;
  } catch (err) {
    console.error('[claude] personalizeMessage failed, using template fallback:', err);
    return substituted;
  }
}
