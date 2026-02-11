const mongoose = require('mongoose');

const privateMessageSchema = new mongoose.Schema({
    from_user: {
        type: String,
        required: [true, 'Sender username is required']
    },
    to_user: {
        type: String,
        required: [true, 'Recipient username is required']
    },
    message: {
        type: String,
        required: [true, 'Message content is required']
    },
    date_sent: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('PrivateMessage', privateMessageSchema);
