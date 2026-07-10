// api/classify-file.js
//
// OneDrive自動整理プロジェクト：ファイル分類API
// PAD（Power Automate Desktop）から呼び出される想定。
// Gemini APIを使用し、ファイル内容から案件名・書面名・格納先を判定してJSONで返却する。
//
// 環境変数（Vercel側で既存登録済み）:
//   GEMINI_API_KEY … 参照のみ。値はコード内に含めない。
//
// リクエスト形式（PADからのPOST）:
// {
//   "filename": "元ファイル名.pdf",
//   "modifiedDate": "2026-07-10",      // ファイル更新日時（YYYY-MM-DD）
//   "mimeType": "application/pdf",     // 画像/音声はマルチモーダル送信、文書はテキスト抽出済みを想定
//   "textContent": "抽出済みテキスト（PDF/Word/Excel等、先頭2000文字程度）",
//   "base64Content": "画像/音声の場合のみ。base64エンコード済みデータ",
//   "projectMaster": { ...案件マスタJSON... },
//   "folderMaster": { ...フォルダ構造マスタJSON... }
// }
//
// レスポンス形式（Phase2確定スキーマ）:
// {
//   "major": string,
//   "middle": string,
//   "minor": string,
//   "project": string,
//   "is_new_project": boolean,
//   "date": "YYYYMMDD",
//   "doc_type": string,
//   "title": string,
//   "new_filename": string,
//   "confidence": number,
//   "reason": string
// }

const GEMINI_MODEL = "gemini-2.5-flash-lite";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `あなたはファイル分類の専門エンジンです。以下の制約に厳格に従ってください。

【役割】
入力されたファイル情報（ファイル名・抽出テキストまたは画像/音声内容・更新日時）から、
案件マスタに定義された案件IDへの分類、文書種別の判定、リネーム用ファイル名の生成を行う。

【厳守事項】
1. 案件マスタ（提供リスト）に類似・一致する案件が存在する場合は、必ずそのidを使用すること（表記揺れは統合すること）。
2. 案件マスタに存在しない新規の案件・会社名と判断される場合は、is_new_project を true とし、
   project にはファイル内容から読み取れる会社名・案件名をそのまま記載すること。
   （新規案件を無理に既存マスタへ当てはめてはならない）
3. 判定根拠となる情報が不十分な場合は、confidence を0.5未満とし、project は "unknown" とすること。
4. major/middleの値は、フォルダ構造マスタに定義された値のみを使用すること。
   ただし新規案件の場合、middleは project と同一の値を提案してよい。
5. dateはファイル内のテキスト・音声内容から読み取れる文書作成日を優先し、
   読み取れない場合は提供された更新日時を使用すること。
6. new_filename は "YYYYMMDD_案件名_書面名.拡張子" の形式とすること（枝番は付与しない。
   枝番は後段のPAD側で連番採番するため、ここでは含めない）。
7. 出力は必ずJSON形式のみとし、説明文・前置き・Markdown記法（\`\`\`等）を一切含めないこと。

【出力スキーマ】
{
  "major": string,
  "middle": string,
  "minor": string,
  "project": string,
  "is_new_project": boolean,
  "date": string,
  "doc_type": string,
  "title": string,
  "new_filename": string,
  "confidence": number,
  "reason": string
}`;

function buildUserPrompt({ filename, modifiedDate, textContent, projectMaster, folderMaster }) {
  return `【案件マスタ】
${JSON.stringify(projectMaster, null, 2)}

【フォルダ構造マスタ】
${JSON.stringify(folderMaster, null, 2)}

【入力ファイル情報】
ファイル名: ${filename}
更新日時: ${modifiedDate}
内容: ${textContent || "(テキスト抽出なし。添付データを参照)"}

上記情報に基づき、指定スキーマのJSONのみを出力してください。`;
}

function stripMarkdownFence(text) {
  return text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  try {
    const {
      filename,
      modifiedDate,
      mimeType,
      textContent,
      base64Content,
      projectMaster,
      folderMaster,
    } = req.body || {};

    if (!filename) {
      res.status(400).json({ error: "filename is required" });
      return;
    }

    const userPrompt = buildUserPrompt({
      filename,
      modifiedDate,
      textContent,
      projectMaster: projectMaster || { projects: [] },
      folderMaster: folderMaster || {},
    });

    // parts組み立て：画像/音声はマルチモーダルで直接添付、文書はテキストのみ
    const parts = [{ text: userPrompt }];
    if (base64Content && mimeType) {
      parts.push({
        inline_data: {
          mime_type: mimeType,
          data: base64Content,
        },
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: "GEMINI_API_KEY is not configured" });
      return;
    }

    const geminiResponse = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!geminiResponse.ok) {
      const errText = await geminiResponse.text();
      res.status(502).json({ error: "Gemini API error", detail: errText });
      return;
    }

    const geminiData = await geminiResponse.json();
    const rawText =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    let parsed;
    try {
      parsed = JSON.parse(stripMarkdownFence(rawText));
    } catch (e) {
      res.status(502).json({
        error: "Failed to parse Gemini response as JSON",
        raw: rawText,
      });
      return;
    }

    res.status(200).json(parsed);
  } catch (error) {
    res.status(500).json({ error: "Internal error", detail: String(error) });
  }
};
