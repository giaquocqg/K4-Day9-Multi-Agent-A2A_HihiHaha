import os
import glob
import zipfile

def create_submission():
    output_dir = "output"
    gitkeep = os.path.join(output_dir, ".gitkeep")
    if os.path.exists(gitkeep):
        os.remove(gitkeep)
        print("Removed output/.gitkeep")

    json_files = sorted(glob.glob(os.path.join(output_dir, "EC_*.json")))
    print(f"Found {len(json_files)} JSON files in output/")

    if len(json_files) != 50:
        print(f"WARNING: Expected 50 files, but found {len(json_files)}")

    zip_filename = "submission.zip"
    with zipfile.ZipFile(zip_filename, "w", zipfile.ZIP_DEFLATED) as zipf:
        for fpath in json_files:
            # Preserve output/ prefix: output/EC_001.json to output/EC_050.json
            arcname = f"output/{os.path.basename(fpath)}"
            zipf.write(fpath, arcname=arcname)

    print(f"Successfully created {zip_filename} containing output/EC_001.json to output/EC_050.json!")

if __name__ == "__main__":
    create_submission()
