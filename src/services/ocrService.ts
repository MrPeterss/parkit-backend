import axios from 'axios';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import type { Worker } from 'tesseract.js';

export type OcrResult = {
  lat: number;
  lng: number;
  rawText: string;
};

let ocrWorker: Worker | null = null;

const getOcrWorker = async (): Promise<Worker> => {
  if (ocrWorker) return ocrWorker;

  const worker = await createWorker('eng');
  ocrWorker = worker;
  return worker;
};

export const extractGpsFromImageUrl = async (
  imageUrl: string | null,
): Promise<OcrResult | null> => {
  if (!imageUrl) return null;

  let inputBuffer: Buffer;

  // Check if it's a base64 data URI
  if (imageUrl.startsWith('data:')) {
    // Extract the base64 data after the comma
    const base64Data = imageUrl.split(',')[1];
    if (!base64Data) {
      console.error('Invalid data URI format');
      return null;
    }
    inputBuffer = Buffer.from(base64Data, 'base64');
    console.log('✅ Decoded base64 image');
  } else {
    // Download the image from URL
    const response = await axios.get<ArrayBuffer>(imageUrl, {
      responseType: 'arraybuffer',
    });
    inputBuffer = Buffer.from(response.data);
    console.log('✅ Downloaded image from URL');
  }

  // Crop the top 60 pixels and apply thresholding for better OCR
  const image = sharp(inputBuffer);
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error('Unable to read image metadata');
  }

  const processedBuffer = await image
    .extract({
      left: 0,
      top: 0,
      width: metadata.width,
      height: Math.min(60, metadata.height),
    })
    .greyscale()
    .threshold()
    .toBuffer();

  // Perform OCR
  const worker = await getOcrWorker();
  const {
    data: { text },
  } = await worker.recognize(processedBuffer);

  const rawText = text;

  // Extract Lat / Lng with regex
  const match = /Lat:\s*([-\d.]+)\s*Lng:\s*([-\d.]+)/i.exec(rawText);

  if (!match) {
    return null;
  }

  const lat = parseFloat(match[1]);
  const lng = parseFloat(match[2]);

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return null;
  }

  return {
    lat,
    lng,
    rawText,
  };
};

export const terminateOcrWorker = async (): Promise<void> => {
  if (ocrWorker) {
    await ocrWorker.terminate();
    ocrWorker = null;
  }
};


