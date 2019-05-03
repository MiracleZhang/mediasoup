#ifndef MS_RTC_RTP_STREAM_SEND_HPP
#define MS_RTC_RTP_STREAM_SEND_HPP

#include "Utils.hpp"
#include "RTC/RtpDataCounter.hpp"
#include "RTC/RtpStream.hpp"
#include <vector>

namespace RTC
{
	class RtpStreamSend : public RTC::RtpStream
	{
	public:
		class Listener : public RTC::RtpStream::Listener
		{
		public:
			virtual void OnRtpStreamRetransmitRtpPacket(
			  RTC::RtpStreamSend* rtpStream, RTC::RtpPacket* packet) = 0;
		};

	public:
		struct BufferItem
		{
			uint16_t seq{ 0 }; // RTP seq.
			RTC::RtpPacket* packet{ nullptr };
			uint64_t resentAtTime{ 0 }; // Last time this packet was resent.
			uint8_t sentTimes{ 0 };     // Number of times this packet was resent.
			bool rtxEncoded{ false };   // Whether the packet has already been RTX encoded.
		};

	private:
		class Buffer
		{
		public:
			Buffer(size_t bufferSize);

			bool Empty() const;
			size_t GetSize() const;
			// Access the first item in the vector.
			const BufferItem& First() const;
			// Access the last item in the vector.
			const BufferItem& Last() const;
			// Access an item in the vector by index relative to startIdx.
			BufferItem& operator[](size_t idx);
			// Access an item in the vector by packet's sequence number (if present).
			BufferItem* GetBySeq(uint16_t seq);
			// Add new item at the end if there is room.
			bool PushBack(const BufferItem& item);
			// Remove the first item from the vector.
			void TrimFront();
			// Inserts item into the buffer so newer packets with higher BufferItem::seq
			// placed are at the end.
			// Returns a pointer to newly added item, or nullptr if packet with the same
			// seq was already stored.
			BufferItem* OrderedInsertBySeq(const BufferItem& item);
			void Clear();
			// TODO: TEMPORAL
			void TmpDump() const;

		private:
			// Vector that can hold up to maxsize of BufferItems plus 1 empty slot
			// reserved for easier inserts.
			std::vector<BufferItem> vctr;
			// Vector index where data begins.
			size_t startIdx{ 0 };
			// Number of items currently stored in the vector. While inserting a new
			// packet we may see cursize == maxsize + 1 until TrimFront() is called.
			size_t currentSize{ 0 };
			// Maximum number of items that can be stored in this Buffer instance.
			size_t maxSize{ 0 };
		};

	private:
		struct StorageItem
		{
			// Allow some more space for RTX encoding.
			uint8_t store[RTC::MtuSize + 200];
		};

	public:
		RtpStreamSend(
		  RTC::RtpStreamSend::Listener* listener, RTC::RtpStream::Params& params, size_t bufferSize);
		~RtpStreamSend() override;

		void FillJsonStats(json& jsonObject) override;
		void SetRtx(uint8_t payloadType, uint32_t ssrc) override;
		bool ReceivePacket(RTC::RtpPacket* packet) override;
		void ReceiveNack(RTC::RTCP::FeedbackRtpNackPacket* nackPacket);
		void ReceiveKeyFrameRequest(RTC::RTCP::FeedbackPs::MessageType messageType);
		void ReceiveRtcpReceiverReport(RTC::RTCP::ReceiverReport* report);
		RTC::RTCP::SenderReport* GetRtcpSenderReport(uint64_t now);
		RTC::RTCP::SdesChunk* GetRtcpSdesChunk();
		void Pause() override;
		void Resume() override;
		uint32_t GetBitrate(uint64_t now) override;
		uint32_t GetBitrate(uint64_t now, uint8_t spatialLayer, uint8_t temporalLayer) override;
		uint32_t GetLayerBitrate(uint64_t now, uint8_t spatialLayer, uint8_t temporalLayer) override;

	private:
		void StorePacket(RTC::RtpPacket* packet);
		void ClearRetransmissionBuffer();
		void FillRetransmissionContainer(uint16_t seq, uint16_t bitmask, std::vector<uint16_t>& seqs);
		void UpdateScore(RTC::RTCP::ReceiverReport* report);

	private:
		uint32_t lostPrior{ 0 }; // Packets lost at last interval.
		uint32_t sentPrior{ 0 }; // Packets sent at last interval.
		std::vector<StorageItem> storage;
		Buffer buffer;
		float rtt{ 0 };
		uint16_t rtxSeq{ 0 };
		RTC::RtpDataCounter transmissionCounter;
	};

	/* Inline instance methods */

	inline RtpStreamSend::Buffer::Buffer(size_t bufferSize)
	  : vctr(bufferSize + 1), startIdx(0), currentSize(0), maxSize(bufferSize)
	{
	}

	inline bool RtpStreamSend::Buffer::Empty() const
	{
		return this->currentSize == 0;
	}

	inline size_t RtpStreamSend::Buffer::GetSize() const
	{
		return this->currentSize;
	}

	inline void RtpStreamSend::Buffer::Clear()
	{
		this->startIdx    = 0;
		this->currentSize = 0;
	}

	inline void RtpStreamSend::SetRtx(uint8_t payloadType, uint32_t ssrc)
	{
		RTC::RtpStream::SetRtx(payloadType, ssrc);

		this->rtxSeq = Utils::Crypto::GetRandomUInt(0u, 0xFFFF);
	}

	inline uint32_t RtpStreamSend::GetBitrate(uint64_t now)
	{
		return this->transmissionCounter.GetBitrate(now);
	}
} // namespace RTC

#endif
