---
name: generate-image
description: Generate an image from a text description and send it into the chat. Use whenever the user asks you to "generate", "create", "make", "draw", or "design" an image, picture, logo, illustration, or artwork. Powered by OpenAI GPT Image 2 via the OneCLI gateway (no API key handling required).
allowed-tools: Bash(curl:*), Bash(jq:*), Bash(base64:*), Bash(ls:*), Bash(file:*), Bash(identify:*)
---

# Generating images

When the user asks for an image, you generate it with OpenAI's **GPT Image 2** model,
save it as a PNG in your workspace, then deliver it with the `send_file` MCP tool.

You do **not** handle any API key. Your outbound HTTPS traffic is proxied through the
OneCLI gateway (see the `onecli-gateway` skill), which injects the OpenAI credential at
the proxy boundary. Just call the real API URL.

## Step 1 — Generate

Call the images endpoint. Write the base64 payload straight to a file to keep it out of
your context (it is large). Use a timestamped filename so repeat requests don't collide.

```bash
OUT="/workspace/agent/gen-$(date +%s).png"

curl -s https://api.openai.com/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "A photorealistic red fox sitting in autumn leaves, golden hour light",
    "size": "1024x1024",
    "quality": "high"
  }' > /tmp/img-resp.json

# Check for an API error before decoding
if jq -e '.error' /tmp/img-resp.json >/dev/null 2>&1; then
  jq -r '.error.message' /tmp/img-resp.json   # read this, then handle per "Errors" below
else
  jq -r '.data[0].b64_json' /tmp/img-resp.json | base64 -d > "$OUT"
  identify "$OUT"   # confirm it's a valid image
fi
```

**Prompt tips.** GPT Image 2 follows detailed instructions well — describe subject, style,
lighting, composition, and mood. It renders text legibly, so quote any exact words the
user wants on the image. Faithfully pass through the user's request; only enrich it when
they ask you to be creative.

### Parameters worth knowing

- `size`: `"1024x1024"` (square, default), `"1536x1024"` (landscape), `"1024x1536"` (portrait).
  Pick to match what the user wants; square is the safe default.
- `quality`: `"low"` | `"medium"` | `"high"`. Default to `"high"` for a single image;
  drop to `"medium"`/`"low"` if the user wants several quick drafts (it's cheaper and faster).
- For **transparent** logos/icons add `"background": "transparent"` — the PNG keeps its alpha channel.
- To generate more than one at once add `"n": 2` and decode each `.data[i].b64_json` to its own file.

## Step 2 — Send it into the chat

Deliver the saved PNG with the `send_file` MCP tool, addressed to the destination the
request came `from`:

```
send_file({ to: "<destination>", path: "/workspace/agent/gen-1730000000.png", text: "Here's the fox 🦊" })
```

The WhatsApp adapter sends PNG/JPG files as inline images with your `text` as the caption.
Keep the caption short — one line is plenty.

## Editing an existing image

To modify an image the user sent (saved under `/workspace/inbox/...`) or one you generated,
use the edit endpoint instead. It takes the source image and a prompt describing the change:

```bash
curl -s https://api.openai.com/v1/images/edits \
  -F "model=gpt-image-2" \
  -F "image=@/workspace/inbox/<id>/photo.png" \
  -F "prompt=Put the person in a spacesuit on the moon" \
  -F "size=1024x1024" > /tmp/edit-resp.json

jq -r '.data[0].b64_json' /tmp/edit-resp.json | base64 -d > /workspace/agent/edited-$(date +%s).png
```

Then `send_file` the result as in Step 2.

## Errors

- **`403` / "organization must be verified"** — the OpenAI org backing the key hasn't been
  verified for GPT Image models, or the key's project doesn't allow `gpt-image-2`. This is a
  one-time human setup step at platform.openai.com — you can't fix it from here. Tell the
  user plainly: *"OpenAI needs your organization verified for GPT Image before I can generate
  images — verify at platform.openai.com → Settings → Organization → General, then try again."*
- **`401` / `app_not_connected`** — the OpenAI credential isn't in the vault. Surface the
  `connect_url` from the error if present, or ask the owner to add the OpenAI key.
- **Content policy refusal** — GPT Image 2 refuses some prompts. Relay the refusal reason
  briefly and offer to adjust the prompt; don't try to circumvent it.
- **Never** ask the user for an API key. Credentials are managed by the OneCLI gateway.
