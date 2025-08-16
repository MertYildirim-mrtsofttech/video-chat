const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

// HTTP sunucusu oluştur (static dosyalar için)
const server = http.createServer((req, res) => {
    // CORS başlıklarını ekle
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.url === '/' || req.url === '/index.html') {
        const htmlPath = path.join(__dirname, 'index.html');
        fs.readFile(htmlPath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Dosya bulunamadı');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
    } else if (req.url === '/status') {
        // Sunucu durumu endpoint'i
        const availableUsers = [...connections.values()].filter(user => user.status === 'available').length;
        const inCallUsers = [...connections.values()].filter(user => user.status === 'in-call').length;
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'online',
            totalConnections: wss ? wss.clients.size : 0,
            availableUsers: availableUsers,
            usersInCall: inCallUsers,
            waitingUsers: waitingQueue.length,
            activeMatches: Math.floor(activeMatches.size / 2),
            uptime: process.uptime()
        }));
    } else {
        res.writeHead(404);
        res.end('Sayfa bulunamadı');
    }
});

// WebSocket sunucusu oluştur
const wss = new WebSocket.Server({ server });

// Kullanıcı durumları
const USER_STATUS = {
    AVAILABLE: 'available',      // Müsait - eşleştirilebilir
    WAITING: 'waiting',          // Partner arıyor
    IN_CALL: 'in-call',         // Aktif görüşmede - rahatsız edilemez
    DISCONNECTING: 'disconnecting' // Ayrılma sürecinde
};

// Aktif bağlantıları ve kullanıcıları saklamak için
const connections = new Map(); // socket -> user data
const waitingQueue = []; // Eşleşme bekleyen kullanıcılar
const activeMatches = new Map(); // socket -> partner socket
const userHistory = new Map(); // userId -> Set of partner userIds (eşleşme geçmişi)

// Rastgele kullanıcı ID oluşturma
function generateUserId() {
    return 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Kullanıcı durumunu güncelle
function updateUserStatus(socket, status) {
    const user = connections.get(socket);
    if (user) {
        const oldStatus = user.status;
        user.status = status;
        user.statusUpdatedAt = new Date();
        
        console.log(`👤 ${user.username}: ${oldStatus} → ${status}`);
        
        // Eğer kullanıcı görüşmeye geçtiyse, onu bekleme kuyruğundan çıkar
        if (status === USER_STATUS.IN_CALL) {
            removeFromWaitingQueue(socket);
        }
        
        broadcastUserStats();
    }
}

// Kullanıcı sayısını tüm bağlı istemcilere gönder
function broadcastUserCount() {
    const userCount = connections.size;
    const message = JSON.stringify({
        type: 'user-count',
        count: userCount
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Detaylı kullanıcı istatistiklerini gönder
function broadcastUserStats() {
    const stats = getUserStats();
    const message = JSON.stringify({
        type: 'user-stats',
        ...stats
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Kullanıcı istatistiklerini al
function getUserStats() {
    const allUsers = [...connections.values()];
    return {
        total: allUsers.length,
        available: allUsers.filter(u => u.status === USER_STATUS.AVAILABLE).length,
        waiting: allUsers.filter(u => u.status === USER_STATUS.WAITING).length,
        inCall: allUsers.filter(u => u.status === USER_STATUS.IN_CALL).length,
        waitingQueue: waitingQueue.length,
        activeMatches: Math.floor(activeMatches.size / 2)
    };
}

// Rastgele eşleşme bul - sadece müsait kullanıcılar arasında
function findMatch(socket) {
    const currentUser = connections.get(socket);
    if (!currentUser) {
        console.log('❌ findMatch: Kullanıcı bulunamadı');
        return false;
    }

    // Kullanıcı durumunu kontrol et
    if (currentUser.status === USER_STATUS.IN_CALL) {
        console.log(`⚠️ ${currentUser.username} zaten görüşmede, eşleştirme yapılmadı`);
        return false;
    }

    console.log(`🔍 ${currentUser.username} için eşleştirme aranıyor...`);
    console.log(`📊 Toplam bekleyen kullanıcı: ${waitingQueue.length}`);
    
    // SADECE MÜSAİT KULLANICILARI FİLTRELE
    const availableUsers = waitingQueue.filter(waitingSocket => {
        if (waitingSocket === socket) {
            console.log('⚠️ Kendisi filtrelendi');
            return false;
        }
        
        const waitingUser = connections.get(waitingSocket);
        if (!waitingUser) {
            console.log('⚠️ Kullanıcı verisi yok');
            return false;
        }
        
        if (waitingSocket.readyState !== WebSocket.OPEN) {
            console.log('⚠️ WebSocket kapalı');
            return false;
        }
        
        // ÖNEMLİ: Aktif görüşmedeki kullanıcıları filtrele
        if (waitingUser.status === USER_STATUS.IN_CALL) {
            console.log(`⚠️ ${waitingUser.username} aktif görüşmede - atlandı`);
            return false;
        }
        
        if (activeMatches.has(waitingSocket)) {
            console.log('⚠️ Zaten aktif eşleşmesi var');
            return false;
        }
        
        // Sadece müsait veya bekleyen kullanıcıları kabul et
        if (waitingUser.status !== USER_STATUS.AVAILABLE && 
            waitingUser.status !== USER_STATUS.WAITING) {
            console.log(`⚠️ ${waitingUser.username} müsait değil (${waitingUser.status})`);
            return false;
        }
        
        console.log(`✅ Uygun kullanıcı: ${waitingUser.username} (${waitingUser.status})`);
        return true;
    });

    console.log(`🎯 Müsait kullanıcı sayısı: ${availableUsers.length}`);

    if (availableUsers.length === 0) {
        console.log('❌ Müsait kullanıcı bulunamadı');
        return false;
    }

    // Rastgele bir kullanıcı seç
    const randomIndex = Math.floor(Math.random() * availableUsers.length);
    const partnerSocket = availableUsers[randomIndex];
    const partnerUser = connections.get(partnerSocket);
    
    if (!partnerUser) {
        console.log('❌ Partner kullanıcı verisi bulunamadı');
        return false;
    }

    console.log(`🎉 Eşleşme bulundu: ${currentUser.username} <-> ${partnerUser.username}`);
    
    // Her iki kullanıcıyı da bekleme kuyruğundan çıkar
    removeFromWaitingQueue(socket);
    removeFromWaitingQueue(partnerSocket);

    // Kullanıcı durumlarını güncelle - henüz görüşme başlamadı, bağlantı kuruluyor
    updateUserStatus(socket, USER_STATUS.WAITING);
    updateUserStatus(partnerSocket, USER_STATUS.WAITING);

    // Eşleşmeyi kaydet
    activeMatches.set(socket, partnerSocket);
    activeMatches.set(partnerSocket, socket);
    
    // Eşleşme geçmişini güncelle
    const currentUserHistory = userHistory.get(currentUser.id) || new Set();
    const partnerUserHistory = userHistory.get(partnerUser.id) || new Set();
    
    const isReconnection = currentUserHistory.has(partnerUser.id);
    
    currentUserHistory.add(partnerUser.id);
    partnerUserHistory.add(currentUser.id);
    
    userHistory.set(currentUser.id, currentUserHistory);
    userHistory.set(partnerUser.id, partnerUserHistory);

    // Her iki kullanıcıya da eşleşmeyi bildir
    try {
        socket.send(JSON.stringify({
            type: 'partner-found',
            partner: partnerUser.username,
            isInitiator: true,
            isReconnection: isReconnection
        }));

        partnerSocket.send(JSON.stringify({
            type: 'partner-found',
            partner: currentUser.username,
            isInitiator: false,
            isReconnection: partnerUserHistory.has(currentUser.id)
        }));
        
        console.log(`✅ Eşleşme mesajları gönderildi`);
    } catch (error) {
        console.error('❌ Eşleşme mesajı gönderme hatası:', error);
        return false;
    }

    console.log(`🎊 Eşleşme başarılı: ${currentUser.username} <-> ${partnerUser.username} ${isReconnection ? '(TEKRAR)' : '(YENİ)'}`);
    
    return true;
}

// Kullanıcıyı bekleme kuyruğuna ekle
function addToWaitingQueue(socket) {
    const user = connections.get(socket);
    
    // Sadece müsait kullanıcıları kuyruğa ekle
    if (user && user.status !== USER_STATUS.IN_CALL && !waitingQueue.includes(socket)) {
        waitingQueue.push(socket);
        updateUserStatus(socket, USER_STATUS.WAITING);
        console.log(`Kullanıcı bekleme kuyruğuna eklendi. Toplam bekleyen: ${waitingQueue.length}`);
    } else if (user && user.status === USER_STATUS.IN_CALL) {
        console.log(`⚠️ ${user.username} görüşmede olduğu için kuyruğa eklenmiyor`);
    }
}

// Kullanıcıyı bekleme kuyruğundan çıkar
function removeFromWaitingQueue(socket) {
    const index = waitingQueue.indexOf(socket);
    if (index > -1) {
        waitingQueue.splice(index, 1);
        console.log(`Kullanıcı bekleme kuyruğundan çıkarıldı. Kalan: ${waitingQueue.length}`);
    }
}

// Aktif eşleşmeyi sonlandır
function endMatch(socket) {
    const partnerSocket = activeMatches.get(socket);
    const currentUser = connections.get(socket);
    
    if (partnerSocket) {
        const partnerUser = connections.get(partnerSocket);
        
        // Partner'a ayrılığı bildir
        if (partnerSocket.readyState === WebSocket.OPEN) {
            partnerSocket.send(JSON.stringify({
                type: 'partner-left'
            }));
        }

        // Eşleşmeleri temizle
        activeMatches.delete(socket);
        activeMatches.delete(partnerSocket);
        
        // Kullanıcı durumlarını güncelle
        if (currentUser) {
            updateUserStatus(socket, USER_STATUS.AVAILABLE);
        }
        if (partnerUser && partnerSocket.readyState === WebSocket.OPEN) {
            updateUserStatus(partnerSocket, USER_STATUS.AVAILABLE);
        }

        console.log(`Eşleşme sonlandırıldı: ${currentUser?.username || 'Unknown'} <-> ${partnerUser?.username || 'Unknown'}`);
        
        // Partner'ı tekrar bekleme kuyruğuna ekle (eğer hala bağlıysa ve müsaitse)
        if (partnerSocket.readyState === WebSocket.OPEN && 
            connections.has(partnerSocket) && 
            partnerUser?.status === USER_STATUS.AVAILABLE) {
            
            setTimeout(() => {
                if (connections.has(partnerSocket) && 
                    !activeMatches.has(partnerSocket)) {
                    addToWaitingQueue(partnerSocket);
                    
                    // Partner için otomatik eşleşme ara
                    setTimeout(() => {
                        if (waitingQueue.includes(partnerSocket)) {
                            findMatch(partnerSocket);
                        }
                    }, 1000);
                }
            }, 500);
        }
    }
}

// Mesajı partner'a ilet
function forwardToPartner(socket, message) {
    const partnerSocket = activeMatches.get(socket);
    
    if (partnerSocket && partnerSocket.readyState === WebSocket.OPEN) {
        partnerSocket.send(JSON.stringify(message));
        return true;
    }
    
    return false;
}

// Tüm WebSocket bağlantılarını dinle
wss.on('connection', (ws) => {
    console.log('🔌 Yeni WebSocket bağlantısı kuruldu');
    
    // Bağlantı durumunu test et
    ws.send(JSON.stringify({
        type: 'connection-established',
        message: 'WebSocket bağlantısı başarılı'
    }));
    
    // Kullanıcı sayısını güncelle
    setTimeout(broadcastUserCount, 100);
    
    // Mesaj dinleyicisi
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);            
            handleMessage(ws, data);
        } catch (error) {
            console.error('❌ Mesaj parse hatası:', error);
            sendError(ws, 'Geçersiz mesaj formatı');
        }
    });
    
    // Bağlantı kapanması
    ws.on('close', (code, reason) => {
        console.log(`❌ WebSocket bağlantısı kapandı: ${code} - ${reason}`);
        handleDisconnect(ws);
    });
    
    // Hata durumu
    ws.on('error', (error) => {
        console.error('💥 WebSocket hatası:', error);
        handleDisconnect(ws);
    });
});

function handleMessage(socket, data) {
    const user = connections.get(socket);
    const userInfo = user ? `${user.username}(${user.id})` : 'Unknown';
    
    console.log(`📨 Mesaj alındı [${userInfo}]: ${data.type}`);
    
    switch (data.type) {
        case 'find-partner':
            handleFindPartner(socket, data);
            break;
            
        case 'offer':
            handleOffer(socket, data);
            break;
            
        case 'answer':
            handleAnswer(socket, data);
            break;
            
        case 'ice-candidate':
            handleIceCandidate(socket, data);
            break;
            
        case 'chat-message':
            handleChatMessage(socket, data);
            break;
            
        case 'call-started':
            handleCallStarted(socket);
            break;
            
        case 'call-ended':
            handleCallEnded(socket);
            break;
            
        case 'disconnect':
            handleDisconnectRequest(socket);
            break;
            
        default:
            console.log(`❓ Bilinmeyen mesaj tipi [${userInfo}]:`, data.type);
    }
}

function handleFindPartner(socket, data) {
    const { username } = data;
    
    // Kullanıcı adı validasyonu
    if (!username || username.length < 2 || username.length > 20) {
        sendError(socket, 'Geçersiz kullanıcı adı!');
        return;
    }

    // Mevcut kullanıcıyı kontrol et
    const existingUser = connections.get(socket);
    if (existingUser && existingUser.status === USER_STATUS.IN_CALL) {
        console.log(`⚠️ ${existingUser.username} görüşmede iken yeni partner arayamaz`);
        sendError(socket, 'Aktif görüşmenizi sonlandırın!');
        return;
    }

    // Basit kullanıcı ID oluştur (kullanıcı adı bazlı)
    const userId = `${username}_${Date.now()}`;
    
    // Kullanıcıyı kaydet
    const user = {
        id: userId,
        username: username.trim(),
        socket: socket,
        status: USER_STATUS.AVAILABLE,
        joinedAt: new Date(),
        statusUpdatedAt: new Date()
    };
    
    connections.set(socket, user);
    console.log(`✅ Yeni kullanıcı kaydedildi: ${username} (ID: ${userId})`);
    
    // Kullanıcının geçmişini başlat (eğer yoksa)
    if (!userHistory.has(userId)) {
        userHistory.set(userId, new Set());
    }
    
    // Mevcut eşleşmesi varsa sonlandır
    if (activeMatches.has(socket)) {
        console.log(`🔄 ${username} mevcut eşleşmesi sonlandırılıyor`);
        endMatch(socket);
    }
    
    // Bekleme kuyruğundan çıkar (eğer varsa)
    removeFromWaitingQueue(socket);
    
    console.log(`🔍 ${username} için eşleşme aranıyor...`);
    const stats = getUserStats();
    console.log(`📊 Mevcut durum: ${stats.waiting} bekleyen, ${stats.inCall} görüşmede, ${stats.activeMatches} aktif eşleşme`);
    
    // Eşleşme bul
    const matchFound = findMatch(socket);
    
    // Eşleşme bulunamadıysa bekleme kuyruğuna ekle
    if (!matchFound) {
        addToWaitingQueue(socket);
        console.log(`⏳ ${username} bekleme kuyruğuna eklendi (Toplam bekleyen: ${waitingQueue.length})`);
        
        // Kullanıcıya bekleme durumunu bildir
        socket.send(JSON.stringify({
            type: 'waiting',
            message: 'Müsait kullanıcı aranıyor...',
            waitingCount: waitingQueue.length,
            availableUsers: stats.available
        }));
    }
    
    // Kullanıcı sayısını güncelle
    broadcastUserStats();
}

function handleOffer(socket, data) {
    const success = forwardToPartner(socket, {
        type: 'offer',
        offer: data.offer
    });
    
    if (!success) {
        sendError(socket, 'Partner bulunamadı! Yeniden eşleşme deneniyor.');
        handleDisconnectRequest(socket);
    }
}

function handleAnswer(socket, data) {
    const success = forwardToPartner(socket, {
        type: 'answer',
        answer: data.answer
    });
    
    if (!success) {
        sendError(socket, 'Partner bulunamadı! Yeniden eşleşme deneniyor.');
        handleDisconnectRequest(socket);
    }
}

function handleIceCandidate(socket, data) {
    forwardToPartner(socket, {
        type: 'ice-candidate',
        candidate: data.candidate
    });
}

function handleChatMessage(socket, data) {
    const { message, sender } = data;
    
    // Mesaj validasyonu
    if (!message || message.trim().length === 0) return;
    if (message.length > 500) {
        sendError(socket, 'Mesaj çok uzun! Maksimum 500 karakter.');
        return;
    }
    
    const success = forwardToPartner(socket, {
        type: 'chat-message',
        message: message.trim(),
        sender: sender
    });
    
    if (success) {
        const user = connections.get(socket);
        console.log(`Chat: [${user?.username || 'Unknown'}] ${message}`);
    }
}

function handleCallStarted(socket) {
    const user = connections.get(socket);
    if (user) {
        updateUserStatus(socket, USER_STATUS.IN_CALL);
        console.log(`📹 ${user.username} görüntülü görüşmeye başladı`);
        
        // Partner'a da aynı durumu bildir
        const partnerSocket = activeMatches.get(socket);
        if (partnerSocket) {
            updateUserStatus(partnerSocket, USER_STATUS.IN_CALL);
        }
    }
}

function handleCallEnded(socket) {
    const user = connections.get(socket);
    if (user) {
        updateUserStatus(socket, USER_STATUS.AVAILABLE);
        console.log(`📱 ${user.username} görüntülü görüşmeyi sonlandırdı`);
    }
}

function handleDisconnectRequest(socket) {
    endMatch(socket);
    removeFromWaitingQueue(socket);
    
    const user = connections.get(socket);
    if (user) {
        updateUserStatus(socket, USER_STATUS.AVAILABLE);
    }
    
    // Yeni eşleşme ara
    setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN && connections.has(socket)) {
            const user = connections.get(socket);
            if (user && user.status === USER_STATUS.AVAILABLE) {
                handleFindPartner(socket, { username: user.username });
            }
        }
    }, 500);
}

function handleDisconnect(socket) {
    // Aktif eşleşmeyi sonlandır
    endMatch(socket);
    
    // Bekleme kuyruğundan çıkar
    removeFromWaitingQueue(socket);
    
    // Bağlantıları temizle
    const user = connections.get(socket);
    connections.delete(socket);
    
    if (user) {
        console.log(`Kullanıcı ayrıldı: ${user.username} (ID: ${user.id}, Durum: ${user.status})`);
        console.log(`Kullanıcının eşleşme geçmişi korundu: ${userHistory.get(user.id)?.size || 0} partner`);
    }
    
    // Kullanıcı sayısını güncelle
    setTimeout(broadcastUserStats, 100);
}

function sendError(socket, message) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'error',
            message: message
        }));
    }
}

// Sunucuyu başlat
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Video Chat Sunucusu başlatıldı!`);
    console.log(`📡 HTTP Server: http://localhost:${PORT}`);
    console.log(`🔌 WebSocket Server: ws://localhost:${PORT}`);
    console.log(`👥 Gelişmiş kullanıcı durumu koruması aktif`);
    console.log('─────────────────────────────────────────');
});

// Periyodik temizlik - kopmuş bağlantıları temizle
setInterval(() => {
    let cleanedConnections = 0;
    let cleanedWaiting = 0;
    let cleanedMatches = 0;
    
    // Kopmuş bağlantıları temizle
    for (const [socket, user] of connections.entries()) {
        if (socket.readyState !== WebSocket.OPEN) {
            connections.delete(socket);
            cleanedConnections++;
        }
    }
    
    // Kopmuş kullanıcıları bekleme kuyruğundan temizle
    for (let i = waitingQueue.length - 1; i >= 0; i--) {
        const socket = waitingQueue[i];
        if (socket.readyState !== WebSocket.OPEN || !connections.has(socket)) {
            waitingQueue.splice(i, 1);
            cleanedWaiting++;
        }
    }
    
    // Kopmuş eşleşmeleri temizle
    for (const [socket, partner] of activeMatches.entries()) {
        if (socket.readyState !== WebSocket.OPEN || 
            partner.readyState !== WebSocket.OPEN ||
            !connections.has(socket) || 
            !connections.has(partner)) {
            activeMatches.delete(socket);
            activeMatches.delete(partner);
            cleanedMatches++;
        }
    }
    
    if (cleanedConnections > 0 || cleanedWaiting > 0 || cleanedMatches > 0) {
        console.log(`🧹 Temizlik: ${cleanedConnections} bağlantı, ${cleanedWaiting} bekleme, ${cleanedMatches} eşleşme`);
        broadcastUserStats();
    }
    
}, 30000); // Her 30 saniyede bir

// Sunucu istatistikleri - her dakika
setInterval(() => {
    const totalHistoryEntries = Array.from(userHistory.values()).reduce((sum, set) => sum + set.size, 0);
    const averageConnections = userHistory.size > 0 ? (totalHistoryEntries / userHistory.size).toFixed(1) : 0;
    const stats = getUserStats();
    
    console.log('📊 Sunucu İstatistikleri:');
    console.log(`   👥 Toplam kullanıcı: ${stats.total}`);
    console.log(`   ✅ Müsait kullanıcı: ${stats.available}`);
    console.log(`   ⏳ Bekleyen: ${stats.waiting}`);
    console.log(`   📹 Görüşmede: ${stats.inCall}`);
    console.log(`   🔗 Aktif eşleşme: ${stats.activeMatches}`);
    console.log(`   🔌 WebSocket bağlantısı: ${wss.clients.size}`);
    console.log(`   📚 Kayıtlı kullanıcı geçmişi: ${userHistory.size}`);
    console.log(`   🔄 Ortalama eşleşme/kullanıcı: ${averageConnections}`);
    console.log(`   ⏱️ Çalışma süresi: ${Math.floor(process.uptime())}s`);
    console.log('─────────────────────────────────────────');
}, 60000); // Her dakika

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Sunucu kapatılıyor...');
    
    // Tüm kullanıcılara bildir
    const shutdownMessage = JSON.stringify({
        type: 'error',
        message: 'Sunucu bakım için kapatılıyor. Lütfen daha sonra tekrar deneyin.'
    });
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(shutdownMessage);
            client.close();
        }
    });
    
    setTimeout(() => {
        server.close(() => {
            console.log('✅ Sunucu kapatıldı.');
            process.exit(0);
        });
    }, 1000);
});

console.log('🎯 Gelişmiş Rastgele Video Chat Sunucusu hazır!');