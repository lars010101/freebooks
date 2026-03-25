/**
 * Skuld — AI Gateway (BYOK)
 *
 * Routes AI calls through the user's own API key.
 * Model-agnostic: supports Anthropic, OpenAI, Google.
 * All AI features are optional — returns null if no key configured.
 */

/**
 * Call AI with a prompt and context.
 *
 * @param {object} dataset - BigQuery dataset
 * @param {string} companyId
 * @param {string} systemPrompt - System/role instructions
 * @param {string} userPrompt - User message
 * @returns {object|null} - { response, model, tokensUsed } or null if AI not configured
 */
async function callAI(dataset, companyId, systemPrompt, userPrompt) {
  // Get AI config from settings
  const [providerRows] = await dataset.query({
    query: `SELECT value FROM finance.settings WHERE company_id = @companyId AND key = 'ai_provider'`,
    params: { companyId },
  });
  const [keyRows] = await dataset.query({
    query: `SELECT value FROM finance.settings WHERE company_id = @companyId AND key = 'ai_api_key'`,
    params: { companyId },
  });

  const provider = providerRows[0]?.value;
  const apiKey = keyRows[0]?.value;

  if (!provider || !apiKey) {
    return null; // AI not configured — feature works without it
  }

  try {
    switch (provider) {
      case 'anthropic':
        return await callAnthropic(apiKey, systemPrompt, userPrompt);
      case 'openai':
        return await callOpenAI(apiKey, systemPrompt, userPrompt);
      case 'google':
        return await callGoogle(apiKey, systemPrompt, userPrompt);
      default:
        return null;
    }
  } catch (err) {
    console.error(`AI call failed (${provider}):`, err.message);
    return { error: err.message, response: null, model: provider, tokensUsed: 0 };
  }
}

/**
 * Call Anthropic Claude API.
 */
async function callAnthropic(apiKey, systemPrompt, userPrompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || `Anthropic API error: ${response.status}`);
  }

  return {
    response: data.content[0]?.text || '',
    model: data.model,
    tokensUsed: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
  };
}

/**
 * Call OpenAI API.
 */
async function callOpenAI(apiKey, systemPrompt, userPrompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 4096,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || `OpenAI API error: ${response.status}`);
  }

  return {
    response: data.choices[0]?.message?.content || '',
    model: data.model,
    tokensUsed: data.usage?.total_tokens || 0,
  };
}

/**
 * Call Google Gemini API.
 */
async function callGoogle(apiKey, systemPrompt, userPrompt) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: { maxOutputTokens: 4096 },
      }),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || `Google API error: ${response.status}`);
  }

  return {
    response: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
    model: 'gemini-2.0-flash',
    tokensUsed: (data.usageMetadata?.promptTokenCount || 0) + (data.usageMetadata?.candidatesTokenCount || 0),
  };
}

/**
 * Classify accounts using AI.
 * Used during onboarding Path 2/3 to suggest PL/BS/CF categories.
 *
 * @param {object} dataset
 * @param {string} companyId
 * @param {object[]} accounts - [{ account_code, account_name }]
 * @param {string} jurisdiction - e.g., 'SE', 'SG'
 * @returns {object[]|null} - accounts with suggested classifications, or null if AI not available
 */
async function classifyAccounts(dataset, companyId, accounts, jurisdiction) {
  const systemPrompt = `You are an expert accountant. Classify the following accounts for a ${jurisdiction} company.
For each account, provide: account_type (Asset/Liability/Equity/Revenue/Expense), 
pl_category, bs_category, and cf_category.
Respond in JSON array format matching the input structure with added fields.`;

  const userPrompt = `Classify these accounts:\n${JSON.stringify(accounts, null, 2)}`;

  const result = await callAI(dataset, companyId, systemPrompt, userPrompt);
  if (!result || !result.response) return null;

  try {
    // Extract JSON from response
    const jsonMatch = result.response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
    // AI response wasn't valid JSON
  }

  return null;
}

/**
 * Suggest bank transaction categorisation using AI.
 *
 * @param {object} dataset
 * @param {string} companyId
 * @param {object[]} transactions - unmatched bank rows
 * @param {object[]} coa - chart of accounts
 * @param {object[]} existingMappings - existing bank mappings
 * @returns {object[]|null}
 */
async function suggestBankCategories(dataset, companyId, transactions, coa, existingMappings) {
  const systemPrompt = `You are an expert bookkeeper. Suggest account categorisations for unmatched bank transactions.
Use only accounts from the provided chart of accounts.
Respond in JSON array format: [{ index, debit_account, credit_account, vat_code, confidence, reasoning }]`;

  const userPrompt = `Chart of Accounts:\n${JSON.stringify(coa.slice(0, 100), null, 2)}

Existing mapping rules (for context):\n${JSON.stringify(existingMappings.slice(0, 50), null, 2)}

Unmatched transactions to categorise:\n${JSON.stringify(transactions, null, 2)}`;

  const result = await callAI(dataset, companyId, systemPrompt, userPrompt);
  if (!result || !result.response) return null;

  try {
    const jsonMatch = result.response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
    // AI response wasn't valid JSON
  }

  return null;
}

module.exports = { callAI, classifyAccounts, suggestBankCategories };
