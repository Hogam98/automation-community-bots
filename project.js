const MESSAGES_FETCH_LIMIT = 100;
const MAX_DISCORD_TEXT_LENGTH = 1900;
const REQUEST_DELAY_MS = 500;
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const FLAG_REGEX = /^\p{Regional_Indicator}{2}$/u;

module.exports = async function (context) {
  const botToken = String(context.secrets.DISCORD_BOT_TOKEN || "").trim();
  const geminiApiKey = String(context.secrets.GEMINI_API_KEY || "").trim();
  const gatewayUrl = String(context.secrets.CLOUDFLARE_GATEWAY_URL || "").replace(/\/+$/, "").trim();
  const gatewayKey = String(context.secrets.GATEWAY_SECRET_KEY || "").trim();

  if (!botToken || !geminiApiKey || !gatewayUrl || !gatewayKey) {
    throw new Error('Missing required secrets "DISCORD_BOT_TOKEN", "GEMINI_API_KEY", "CLOUDFLARE_GATEWAY_URL", or "GATEWAY_SECRET_KEY".');
  }

  const channels = [];
  for (const [key, value] of Object.entries(context.secrets)) {
    if (!key.endsWith("_CHANNEL_ID") || key.includes("SANDBOX")) {
      continue;
    }

    const channelId = String(value || "").trim();
    if (!channelId) {
      continue;
    }

    const prefix = key.slice(0, -"_CHANNEL_ID".length);
    const webhookId = String(context.secrets[`${prefix}_WEBHOOK_ID`] || "").trim();
    const webhookToken = String(context.secrets[`${prefix}_WEBHOOK_TOKEN`] || "").trim();

    if (!webhookId || !webhookToken) {
      throw new Error(`Missing webhook secrets "${prefix}_WEBHOOK_ID" or "${prefix}_WEBHOOK_TOKEN".`);
    }

    channels.push({ name: prefix, channelId, webhookId, webhookToken });
  }

  if (channels.length === 0) {
    throw new Error("No community Discord channels configured in secrets.");
  }

  const discordHeaders = {
    Authorization: `Bot ${botToken}`,
    "User-Agent": "DiscordBot (Automation, 1.0)"
  };

  for (const channel of channels) {
    const messages = await context.gateway.getJson(
      `/discord/api/v10/channels/${channel.channelId}/messages?limit=${MESSAGES_FETCH_LIMIT}`,
      discordHeaders
    );

    if (!Array.isArray(messages)) {
      continue;
    }

    for (const message of messages.reverse()) {
      const text = String(message.content || "").trim();
      const reactions = Array.isArray(message.reactions) ? message.reactions : [];

      if (!text || message.author?.bot || message.webhook_id || reactions.length === 0) {
        continue;
      }

      const flagEmojis = [];
      for (const reaction of reactions) {
        if (reaction.emoji?.id) {
          continue;
        }

        const emojiName = String(reaction.emoji?.name || "");
        if (FLAG_REGEX.test(emojiName) && !reaction.me && !flagEmojis.includes(emojiName)) {
          flagEmojis.push(emojiName);
        }
      }

      if (flagEmojis.length === 0) {
        continue;
      }

      const rawUsername = message.member?.nick || message.author?.global_name || message.author?.username || "User";
      const safeUsername = String(rawUsername)
        .replace(/discord/gi, "D\u200biscord")
        .replace(/clyde/gi, "C\u200blyde")
        .replace(/```/g, "")
        .trim();
      const username = (safeUsername.length < 2 ? `${safeUsername}.` : safeUsername).slice(0, 80);

      let avatarUrl = "";
      if (message.member?.avatar && message.guild_id && message.author?.id) {
        const ext = message.member.avatar.startsWith("a_") ? "gif" : "png";
        avatarUrl = `https://cdn.discordapp.com/guilds/${message.guild_id}/users/${message.author.id}/avatars/${message.member.avatar}.${ext}?size=256`;
      } else if (message.author?.avatar && message.author?.id) {
        const ext = message.author.avatar.startsWith("a_") ? "gif" : "png";
        avatarUrl = `https://cdn.discordapp.com/avatars/${message.author.id}/${message.author.avatar}.${ext}?size=256`;
      } else {
        const defaultIndex = message.author?.id ? Number((BigInt(message.author.id) >> 22n) % 6n) : 0;
        avatarUrl = `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
      }

      for (const flagEmoji of flagEmojis) {
        const geminiResponse = await context.gateway.postJson(
          `/gemini/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiApiKey}`,
          {
            systemInstruction: {
              parts: [
                {
                  text: "You are a translator. Identify the primary official language represented by the provided flag emoji and translate the user's Discord message into that language while preserving tone, formatting, mentions, emojis, and links. Output only the translated text without any introduction, notes, or quotes."
                }
              ]
            },
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: `Flag: ${flagEmoji}\n\nMessage:\n${text}`
                  }
                ]
              }
            ],
            generationConfig: {
              temperature: 0.2
            }
          }
        );

        const translatedText = String(geminiResponse?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
        if (!translatedText) {
          continue;
        }

        await context.gateway.postJson(
          `/discord/api/v10/webhooks/${channel.webhookId}/${channel.webhookToken}?wait=true`,
          {
            content: `${flagEmoji} ${translatedText.slice(0, MAX_DISCORD_TEXT_LENGTH)}`,
            username,
            avatar_url: avatarUrl,
            allowed_mentions: { parse: [] }
          }
        );

        await context.sleep(REQUEST_DELAY_MS);

        const reactionPath = `/discord/api/v10/channels/${channel.channelId}/messages/${message.id}/reactions/${encodeURIComponent(flagEmoji)}/@me`;
        const reactionResponse = await fetch(`${gatewayUrl}${reactionPath}`, {
          method: "PUT",
          headers: {
            "x-gateway-key": gatewayKey,
            Authorization: `Bot ${botToken}`,
            "User-Agent": "DiscordBot (Automation, 1.0)"
          }
        });

        if (!reactionResponse.ok) {
          const errorBody = await reactionResponse.text().catch(() => "");
          throw new Error(`Failed to add reaction (${reactionResponse.status}): ${errorBody}`);
        }

        console.log(`Translated message ${message.id} (${flagEmoji}) in ${channel.name}.`);
        await context.sleep(REQUEST_DELAY_MS);
      }
    }
  }
};
