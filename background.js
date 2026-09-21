// background.js - Mendengarkan perintah shortcut global keyboard (Alt+L)
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-lyrics-pip") {
    // Cari tab YouTube Music yang sedang aktif
    chrome.tabs.query({ url: "https://music.youtube.com/*" }, (tabs) => {
      if (tabs.length > 0) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "toggle-pip" });
      }
    });
  }
});
