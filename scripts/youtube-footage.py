"""Run the project's isolated yt-dlp installation without changing global Python."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / ".runtime" / "youtube"))
try:
    from yt_dlp import main
except ImportError:
    sys.exit("Install YouTube footage support with: npm run setup:youtube")

if __name__ == "__main__":
    main()
