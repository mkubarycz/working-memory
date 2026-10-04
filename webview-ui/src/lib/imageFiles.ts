interface ImageTransfer {
  files: FileList;
  items: DataTransferItemList;
}

export function imageFilesFromTransfer(transfer: ImageTransfer | null): File[] {
  if (!transfer) {
    return [];
  }

  const files: File[] = [];
  const seen = new Set<string>();
  const add = (file: File | null): void => {
    if (!file?.type.startsWith('image/')) {
      return;
    }
    const key = `${file.name}\0${file.type}\0${file.size}\0${file.lastModified}`;
    if (!seen.has(key)) {
      seen.add(key);
      files.push(file);
    }
  };

  for (const item of Array.from(transfer.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      add(item.getAsFile());
    }
  }
  if (files.length > 0) {
    return files;
  }
  for (const file of Array.from(transfer.files)) {
    add(file);
  }
  return files;
}
