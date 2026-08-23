"""
barcode_worker.py
Runs inside GitHub Actions (see .github/workflows/barcode-tasks.yml).
Two modes, chosen by the MODE env var ("generate" or "download"):

  generate  -> For every row where "Item Code" is filled in AND the
               "Barcode" cell is blank: generate a Code128 barcode and
               upload it straight into that row's Barcode cell in
               Smartsheet. Nothing is saved anywhere else. Rows that
               already have a barcode are left untouched.

  download  -> For every row with an Item Code, build a labeled barcode
               image (Item Name above the barcode) and, if the row has a
               product photo in the "Image" column, combine them side by
               side. Upload the result into the shared Google Drive
               folder (DRIVE_FOLDER_ID). Smartsheet's Barcode column is
               never touched in this mode. Files already present in the
               Drive folder (matched by filename) are skipped so re-runs
               don't create duplicates.

Required environment variables (set as GitHub secrets, passed in by the
workflow file):
  SMARTSHEET_ACCESS_TOKEN   - Smartsheet API token
  GOOGLE_SERVICE_ACCOUNT_JSON - full JSON key of a Google service account
                                that has been given "Editor" access to the
                                DRIVE_FOLDER_ID folder (share the folder
                                with the service account's email address,
                                found in the JSON key as "client_email").
                                Only required for MODE=download.
  DRIVE_FOLDER_ID           - target Google Drive folder ID
  MODE                      - "generate" or "download"

FONT: item-name labels are drawn with fonts/LabelFont.ttf if present in
this repo. Bahnschrift (used previously on Windows) is a Windows system
font and can't be redistributed, so add any similar condensed sans-serif
.ttf you're licensed to use as fonts/LabelFont.ttf. If it's missing, PIL's
built-in default font is used instead (less pretty, but never fails).
"""

import io
import json
import os
import re
import sys
import tempfile

import requests
import smartsheet
import barcode
from barcode.writer import ImageWriter
from PIL import Image, ImageDraw, ImageFont

# ===================== CONFIG =====================

SHEET_ID = 114307621670788  # item master sheet (same as Barcode.py)
ITEM_CODE_COLUMN_NAME = "Item Code"
BARCODE_COLUMN_NAME = "Barcode"
ITEM_NAME_COLUMN_NAME = "Item"
ITEM_IMAGE_COLUMN_NAME = "Image"

BARCODE_FONT_SIZE = 8
BARCODE_TEXT_DISTANCE = 4

LABEL_FONT_PATH = os.path.join(os.path.dirname(__file__), "fonts", "LabelFont.ttf")
LABEL_FONT_SIZE = 34            # was 25 — bigger, closer to the original Bahnschrift look
LABEL_GAP_PX = 4
LABEL_TOP_PADDING_PX = 26       # more breathing room above the item name (was 10)
LABEL_LINE_SPACING_PX = 8
LABEL_STROKE_WIDTH = 1          # thickens the strokes a bit to fake a semi-bold weight
                                 # when LabelFont.ttf isn't itself a bold weight

PRINT_PHOTO_BOX_WIDTH_PX = 250
PRINT_PHOTO_BOX_HEIGHT_PX = 290
PRINT_DIVIDER_PX = 2
PRINT_BORDER_PX = 2

MODE = os.environ.get("MODE", "generate").strip().lower()
DRIVE_FOLDER_ID = os.environ.get("DRIVE_FOLDER_ID", "").strip()


# ===================== SMARTSHEET HELPERS =====================

def get_smartsheet_token():
    token = os.environ.get("SMARTSHEET_ACCESS_TOKEN")
    if not token:
        sys.exit("SMARTSHEET_ACCESS_TOKEN is not set.")
    return token


def get_column_map(sheet):
    return {col.title: col.id for col in sheet.columns}


def sanitize_filename(text):
    cleaned = re.sub(r'[<>:"/\\|?*]', '', text)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return cleaned


def build_file_label(item_code, item_name):
    if item_name:
        return sanitize_filename(f"{item_code} - {item_name}")
    return sanitize_filename(item_code)


def get_cell_image_bytes(token, image_id, width=None, height=None):
    url = "https://api.smartsheet.com/2.0/imageurls"
    request_item = {"imageId": image_id}
    if width:
        request_item["width"] = width
    if height:
        request_item["height"] = height
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    resp = requests.post(url, headers=headers, json=[request_item], timeout=15)
    resp.raise_for_status()
    image_url = resp.json()["imageUrls"][0]["url"]

    img_resp = requests.get(image_url, timeout=15)
    img_resp.raise_for_status()
    return img_resp.content


def upload_image_to_cell(token, sheet_id, row_id, column_id, image_path, alt_text=""):
    url = f"https://api.smartsheet.com/2.0/sheets/{sheet_id}/rows/{row_id}/columns/{column_id}/cellimages"
    with open(image_path, "rb") as f:
        file_bytes = f.read()
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "image/png",
        "Content-Disposition": f'attachment; filename="{os.path.basename(image_path)}"',
        "Content-Length": str(len(file_bytes)),
    }
    params = {"altText": alt_text} if alt_text else {}
    resp = requests.post(url, headers=headers, params=params, data=file_bytes)
    resp.raise_for_status()
    return resp.json()


# ===================== IMAGE BUILDING (same approach as Barcode.py) =====================

def generate_barcode_image(item_code, folder):
    os.makedirs(folder, exist_ok=True)
    writer = ImageWriter()
    code = barcode.get('code128', item_code, writer=writer)
    return code.save(
        os.path.join(folder, item_code),
        options={"font_size": BARCODE_FONT_SIZE, "text_distance": BARCODE_TEXT_DISTANCE},
    )


def _get_label_font():
    try:
        font = ImageFont.truetype(LABEL_FONT_PATH, LABEL_FONT_SIZE)
        print(f"[FONT] Loaded custom label font from {LABEL_FONT_PATH}")
        return font
    except Exception as e:
        print(f"[FONT] Could not load {LABEL_FONT_PATH} ({e}) — falling back to PIL's "
              f"built-in default font. This is almost certainly why labels look cramped/small.")
        return ImageFont.load_default()


def wrap_text_to_width(text, font, max_width, draw):
    words = text.split()
    if not words:
        return [text]
    lines = []
    current_line = words[-1]
    for word in reversed(words[:-1]):
        candidate = f"{word} {current_line}"
        bbox = draw.textbbox((0, 0), candidate, font=font, stroke_width=LABEL_STROKE_WIDTH)
        if (bbox[2] - bbox[0]) <= max_width:
            current_line = candidate
        else:
            lines.insert(0, current_line)
            current_line = word
    lines.insert(0, current_line)
    return lines


def build_labeled_barcode_image(barcode_path, item_name):
    barcode_img = Image.open(barcode_path).convert("RGB")
    bw, bh = barcode_img.size
    font = _get_label_font()

    dummy = Image.new("RGB", (1, 1))
    draw = ImageDraw.Draw(dummy)
    lines = wrap_text_to_width(item_name, font, bw, draw)

    line_bboxes = [draw.textbbox((0, 0), line, font=font, stroke_width=LABEL_STROKE_WIDTH) for line in lines]
    line_widths = [b[2] - b[0] for b in line_bboxes]
    line_heights = [b[3] - b[1] for b in line_bboxes]

    text_block_h = sum(line_heights) + LABEL_LINE_SPACING_PX * (len(lines) - 1)
    max_line_w = max(line_widths)

    canvas_w = max(bw, max_line_w + 20)
    canvas_h = LABEL_TOP_PADDING_PX + text_block_h + LABEL_GAP_PX + bh
    canvas = Image.new("RGB", (canvas_w, canvas_h), "white")
    draw = ImageDraw.Draw(canvas)

    y = LABEL_TOP_PADDING_PX
    for line, bbox, w, h in zip(lines, line_bboxes, line_widths, line_heights):
        x = (canvas_w - w) // 2
        draw.text(
            (x - bbox[0], y - bbox[1]), line, font=font, fill="black",
            stroke_width=LABEL_STROKE_WIDTH, stroke_fill="black",
        )
        y += h + LABEL_LINE_SPACING_PX

    barcode_x = (canvas_w - bw) // 2
    canvas.paste(barcode_img, (barcode_x, LABEL_TOP_PADDING_PX + text_block_h + LABEL_GAP_PX))
    return canvas


def build_print_image(labeled_barcode_img, product_image_bytes):
    left_img = labeled_barcode_img
    left_w, left_h = left_img.size

    photo = Image.open(io.BytesIO(product_image_bytes)).convert("RGB")
    scale_p = min(PRINT_PHOTO_BOX_WIDTH_PX / photo.width, PRINT_PHOTO_BOX_HEIGHT_PX / photo.height)
    fitted = photo.resize((round(photo.width * scale_p), round(photo.height * scale_p))) if scale_p < 1 else photo

    right_img = Image.new("RGB", (PRINT_PHOTO_BOX_WIDTH_PX, PRINT_PHOTO_BOX_HEIGHT_PX), "white")
    paste_x = (PRINT_PHOTO_BOX_WIDTH_PX - fitted.width) // 2
    paste_y = (PRINT_PHOTO_BOX_HEIGHT_PX - fitted.height) // 2
    right_img.paste(fitted, (paste_x, paste_y))
    right_w, right_h = right_img.size

    inner_w = left_w + PRINT_DIVIDER_PX + right_w
    inner_h = max(left_h, right_h)
    inner = Image.new("RGB", (inner_w, inner_h), "white")
    inner.paste(left_img, (0, (inner_h - left_h) // 2))
    inner.paste(right_img, (left_w + PRINT_DIVIDER_PX, (inner_h - right_h) // 2))

    draw = ImageDraw.Draw(inner)
    draw.line([(left_w, 0), (left_w, inner_h)], fill="black", width=PRINT_DIVIDER_PX)

    bordered = Image.new("RGB", (inner_w + 2 * PRINT_BORDER_PX, inner_h + 2 * PRINT_BORDER_PX), "black")
    bordered.paste(inner, (PRINT_BORDER_PX, PRINT_BORDER_PX))
    return bordered


# ===================== GOOGLE DRIVE HELPERS (download mode only) =====================

def get_drive_service():
    # Uses OAuth as YOUR Google account (via a saved refresh token), not a
    # service account - service accounts have no Drive storage quota of
    # their own on a regular (non-Shared-Drive) folder, so uploads to a
    # personal Drive folder fail with a storageQuotaExceeded error. See
    # get_drive_refresh_token.py for how these three values are generated.
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    client_id = os.environ.get("GOOGLE_OAUTH_CLIENT_ID")
    client_secret = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET")
    refresh_token = os.environ.get("GOOGLE_OAUTH_REFRESH_TOKEN")
    if not (client_id and client_secret and refresh_token):
        sys.exit(
            "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / "
            "GOOGLE_OAUTH_REFRESH_TOKEN are not all set (required for MODE=download). "
            "Run get_drive_refresh_token.py once locally to generate them."
        )

    creds = Credentials(
        token=None,
        refresh_token=refresh_token,
        client_id=client_id,
        client_secret=client_secret,
        token_uri="https://oauth2.googleapis.com/token",
        scopes=["https://www.googleapis.com/auth/drive"],
    )
    return build("drive", "v3", credentials=creds)


def drive_file_exists(service, folder_id, filename):
    query = (
        f"'{folder_id}' in parents and name = '{filename}' and trashed = false"
    )
    resp = service.files().list(q=query, fields="files(id, name)", pageSize=1).execute()
    return bool(resp.get("files"))


def upload_to_drive(service, folder_id, local_path, filename):
    from googleapiclient.http import MediaFileUpload

    metadata = {"name": filename, "parents": [folder_id]}
    media = MediaFileUpload(local_path, mimetype="image/png")
    service.files().create(body=metadata, media_body=media, fields="id").execute()


# ===================== MODE: generate =====================
# Only fills blank Barcode cells. Never touches Drive.

def run_generate_mode(client, token):
    sheet = client.Sheets.get_sheet(SHEET_ID)
    cols = get_column_map(sheet)
    item_code_col_id = cols.get(ITEM_CODE_COLUMN_NAME)
    barcode_col_id = cols.get(BARCODE_COLUMN_NAME)
    if item_code_col_id is None or barcode_col_id is None:
        sys.exit(f"Could not find required columns. Found: {list(cols.keys())}")

    with tempfile.TemporaryDirectory() as tmp:
        created, skipped_no_code, skipped_has_barcode, failed = 0, 0, 0, 0
        for row in sheet.rows:
            item_code_val, barcode_val = None, None
            for cell in row.cells:
                if cell.column_id == item_code_col_id:
                    item_code_val = cell.value
                elif cell.column_id == barcode_col_id:
                    barcode_val = cell.value

            if not item_code_val:
                skipped_no_code += 1
                continue
            if barcode_val:
                skipped_has_barcode += 1
                continue

            try:
                plain_path = generate_barcode_image(item_code_val, tmp)
                upload_image_to_cell(token, SHEET_ID, row.id, barcode_col_id, plain_path, alt_text=item_code_val)
                created += 1
                print(f"[OK] Row {row.row_number}: barcode created for '{item_code_val}'")
            except Exception as e:
                failed += 1
                print(f"[FAIL] Row {row.row_number}: '{item_code_val}': {e}")

    print(f"\nDone (generate). Created {created}, skipped {skipped_no_code} (no Item Code), "
          f"skipped {skipped_has_barcode} (already had a barcode), {failed} failed.")


# ===================== MODE: download =====================
# Builds barcode(+photo) images and uploads them to the shared Drive folder.
# Never touches Smartsheet's Barcode column.

def run_download_mode(client, token):
    if not DRIVE_FOLDER_ID:
        sys.exit("DRIVE_FOLDER_ID is not set.")

    sheet = client.Sheets.get_sheet(SHEET_ID)
    cols = get_column_map(sheet)
    item_code_col_id = cols.get(ITEM_CODE_COLUMN_NAME)
    item_name_col_id = cols.get(ITEM_NAME_COLUMN_NAME)
    item_image_col_id = cols.get(ITEM_IMAGE_COLUMN_NAME)
    if item_code_col_id is None:
        sys.exit(f"Could not find '{ITEM_CODE_COLUMN_NAME}' column.")

    drive = get_drive_service()

    with tempfile.TemporaryDirectory() as tmp:
        uploaded, skipped_exists, skipped_no_code, failed = 0, 0, 0, 0
        for row in sheet.rows:
            item_code_val, item_name_val, item_image_val = None, None, None
            for cell in row.cells:
                if cell.column_id == item_code_col_id:
                    item_code_val = cell.value
                elif item_name_col_id is not None and cell.column_id == item_name_col_id:
                    item_name_val = cell.value
                elif item_image_col_id is not None and cell.column_id == item_image_col_id:
                    item_image_val = cell.image

            if not item_code_val:
                skipped_no_code += 1
                continue

            file_label = build_file_label(item_code_val, item_name_val)
            filename = f"{file_label}.png"

            if drive_file_exists(drive, DRIVE_FOLDER_ID, filename):
                skipped_exists += 1
                continue

            try:
                plain_path = generate_barcode_image(item_code_val, tmp)
                labeled_img = (
                    build_labeled_barcode_image(plain_path, item_name_val)
                    if item_name_val else Image.open(plain_path).convert("RGB")
                )

                if item_image_val is not None:
                    img_bytes = get_cell_image_bytes(
                        token, item_image_val.id,
                        getattr(item_image_val, "width", None),
                        getattr(item_image_val, "height", None),
                    )
                    final_img = build_print_image(labeled_img, img_bytes)
                else:
                    final_img = labeled_img

                out_path = os.path.join(tmp, filename)
                final_img.save(out_path)
                upload_to_drive(drive, DRIVE_FOLDER_ID, out_path, filename)
                uploaded += 1
                print(f"[OK] Row {row.row_number}: uploaded '{filename}' to Drive")
            except Exception as e:
                failed += 1
                print(f"[FAIL] Row {row.row_number}: '{item_code_val}': {e}")

    print(f"\nDone (download). Uploaded {uploaded}, skipped {skipped_exists} (already in Drive), "
          f"skipped {skipped_no_code} (no Item Code), {failed} failed.")


# ===================== MAIN =====================

def main():
    token = get_smartsheet_token()
    client = smartsheet.Smartsheet(token)
    client.errors_as_exceptions(True)

    if MODE == "generate":
        run_generate_mode(client, token)
    elif MODE == "download":
        run_download_mode(client, token)
    else:
        sys.exit(f'Unknown MODE "{MODE}" — expected "generate" or "download".')


if __name__ == "__main__":
    main()
